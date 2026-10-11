#include "midi.h"

#include <android/log.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

#include "engine.h"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "PadMidi", __VA_ARGS__)

namespace pad {

namespace {

constexpr int kFirstPadNote = 36;  // FIRST_PAD_NOTE in atomMap.ts
constexpr int kSetupCc = 86;       // the Setup button in atomMap.ts

/** applyCurve() in velocity.ts. */
int applyCurve(int v, float gamma) {
  const double x = 127 * std::pow(v / 127.0, gamma);
  return std::clamp(static_cast<int>(std::lround(x)), 1, 127);
}

/** Bytes per message by status, or 0 for variable/unsupported. */
int messageLength(uint8_t status) {
  switch (status & 0xF0) {
    case 0x80:
    case 0x90:
    case 0xA0:
    case 0xB0:
    case 0xE0:
      return 3;
    case 0xC0:
    case 0xD0:
      return 2;
    default:
      return 0;
  }
}

}  // namespace

Midi &Midi::get() {
  static Midi midi;
  return midi;
}

bool Midi::open(JNIEnv *env, jobject midiDevice, Forward forward) {
  close();
  if (AMidiDevice_fromJava(env, midiDevice, &device_) != AMEDIA_OK) {
    LOG("AMidiDevice_fromJava failed");
    device_ = nullptr;
    return false;
  }
  if (AMidiOutputPort_open(device_, 0, &output_) != AMEDIA_OK) output_ = nullptr;
  if (AMidiInputPort_open(device_, 0, &input_) != AMEDIA_OK) input_ = nullptr;
  if (!output_ || !input_) {
    LOG("port open failed (out=%p in=%p)", output_, input_);
    close();
    return false;
  }
  forward_ = std::move(forward);
  for (auto &l : last_) l = LastHit{};
  std::fill(std::begin(held_), std::end(held_), false);
  setupHeld_ = false;
  reading_ = true;
  reader_ = std::thread([this] { readLoop(); });
  LOG("ATOM opened");
  return true;
}

void Midi::close() {
  reading_ = false;
  if (reader_.joinable()) reader_.join();
  {
    std::lock_guard<std::mutex> lock(sendMutex_);
    if (input_) AMidiInputPort_close(input_);
    input_ = nullptr;
  }
  if (output_) AMidiOutputPort_close(output_);
  output_ = nullptr;
  if (device_) AMidiDevice_release(device_);
  device_ = nullptr;
}

bool Midi::send(const uint8_t *data, size_t len) {
  std::lock_guard<std::mutex> lock(sendMutex_);
  if (!input_) return false;
  return AMidiInputPort_send(input_, data, len) == static_cast<ssize_t>(len);
}

void Midi::setShaping(const Shaping &s) {
  std::lock_guard<std::mutex> lock(configMutex_);
  shaping_ = s;
}

void Midi::setLive(const Live &live) {
  std::lock_guard<std::mutex> lock(configMutex_);
  live_ = live;
}

void Midi::setHitLeds(const std::array<std::vector<uint8_t>, 16> &down, const std::array<std::vector<uint8_t>, 16> &up) {
  std::lock_guard<std::mutex> lock(configMutex_);
  ledDown_ = down;
  ledUp_ = up;
}

void Midi::readLoop() {
  uint8_t buf[256];
  std::vector<uint8_t> msg;
  uint8_t running = 0;
  bool inSysex = false;
  while (reading_) {
    int32_t opcode;
    size_t n = 0;
    int64_t ts = 0;
    const ssize_t got = AMidiOutputPort_receive(output_, &opcode, buf, sizeof buf, &n, &ts);
    if (got <= 0) {
      // AMidi has no blocking read; 0.25 ms polling keeps the added delay negligible.
      std::this_thread::sleep_for(std::chrono::microseconds(250));
      continue;
    }
    if (opcode != AMIDI_OPCODE_DATA || n == 0) continue;
    if (ts <= 0) ts = nowNs();

    // Split into complete messages (running status, real-time bytes, SysEx skipped),
    // like splitMidiMessages() in split.ts.
    for (size_t i = 0; i < n; i++) {
      const uint8_t b = buf[i];
      if (b >= 0xF8) {
        handle(&b, 1, ts);
        continue;
      }
      if (inSysex) {
        if (b == 0xF7) inSysex = false;
        continue;
      }
      if (b & 0x80) {
        if (b == 0xF0) {
          inSysex = true;
          running = 0;
          msg.clear();
          continue;
        }
        running = messageLength(b) ? b : 0;
        msg.assign(1, b);
      } else {
        if (!running) continue;
        if (msg.empty()) msg.assign(1, running);
        msg.push_back(b);
      }
      if (running && static_cast<int>(msg.size()) == messageLength(running)) {
        handle(msg.data(), msg.size(), ts);
        msg.clear();
      }
    }
  }
}

void Midi::handle(const uint8_t *m, size_t len, int64_t t) {
  const uint8_t type = m[0] & 0xF0;
  const int pad = len == 3 ? m[1] - kFirstPadNote : -1;
  const bool isPad = pad >= 0 && pad < 16;
  if (type == 0xB0 && len == 3 && m[1] == kSetupCc) setupHeld_ = m[2] > 0;

  if (type == 0x90 && m[2] > 0 && isPad && !setupHeld_) {
    held_[pad] = true;
    std::lock_guard<std::mutex> lock(configMutex_);
    // Same decisions as InputBus.normalize(): threshold first, then the double-trigger guard.
    const int raw = m[2];
    LastHit &prev = last_[pad];
    const bool guarded = prev.t != INT64_MIN && t - prev.t < static_cast<int64_t>(shaping_.doubleTriggerMs) * 1000000 && raw <= prev.velocity;
    if (raw >= shaping_.threshold && !guarded) {
      prev = {t, raw};
      if (live_.mask & (1u << pad)) {
        const int velocity = live_.fixedVelocity > 0 ? live_.fixedVelocity : applyCurve(raw, shaping_.curveGamma);
        Engine &e = Engine::get();
        if (live_.synth) {
          e.synthNoteOn(pad, velocity, live_.patch, live_.freqs[pad], 0);
        } else if (const Kit *kit = e.currentKit(); kit && kit->pads[pad] >= 0) {
          e.playInstrument(kit, kit->pads[pad], velocity, 0);
        }
      }
    }
    // Hit light, like AtomDriver's padDown (it lights every hit, even ones shaping drops).
    if (!ledDown_[pad].empty()) send(ledDown_[pad].data(), ledDown_[pad].size());
  } else if ((type == 0x80 || (type == 0x90 && m[2] == 0)) && isPad && held_[pad]) {
    // Only real releases: the Setup button flushes note-offs for all 16 pads.
    held_[pad] = false;
    std::lock_guard<std::mutex> lock(configMutex_);
    if (live_.synth && (live_.mask & (1u << pad))) Engine::get().synthNoteOff(pad);
    if (!ledUp_[pad].empty()) send(ledUp_[pad].data(), ledUp_[pad].size());
  }
  if (forward_) forward_(m, len, t);
}

}  // namespace pad
