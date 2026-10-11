// ATOM MIDI over the NDK AMidi API. A reader thread polls the device; pad hits on "live"
// pads trigger the engine right there (no Java/JS hop), then every message is forwarded to
// JS, which runs the same AtomDriver as the web app through a Web MIDI stand-in.
#pragma once

#include <amidi/AMidi.h>
#include <jni.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

#include "engine.h"

namespace pad {

/** Mirrors InputShaping + DoubleTriggerGuard + applyCurve in src/input. */
struct Shaping {
  int threshold = 1;
  float curveGamma = 1;
  int doubleTriggerMs = 0;
};

class Midi {
 public:
  using Forward = std::function<void(const uint8_t *data, size_t len, int64_t timestampNs)>;

  static Midi &get();

  bool open(JNIEnv *env, jobject midiDevice, Forward forward);
  void close();
  bool isOpen() const { return input_ != nullptr; }
  bool send(const uint8_t *data, size_t len);

  /**
   * Pads (bit per pad) that sound natively the moment they're hit: the current kit, or the
   * synth with `patch` at `freqs[pad]` Hz. `fixedVelocity` > 0 replaces the hit velocity.
   */
  struct Live {
    uint32_t mask = 0;
    int fixedVelocity = 0;
    bool synth = false;
    SynthPatch patch;
    std::array<float, 16> freqs{};
  };
  void setLive(const Live &live);
  void setShaping(const Shaping &s);
  /** LED messages sent straight from the reader thread on pad down/up (empty = leave as is). */
  void setHitLeds(const std::array<std::vector<uint8_t>, 16> &down, const std::array<std::vector<uint8_t>, 16> &up);

 private:
  Midi() = default;
  void readLoop();
  void handle(const uint8_t *msg, size_t len, int64_t t);

  AMidiDevice *device_ = nullptr;
  AMidiOutputPort *output_ = nullptr;  // device -> us
  AMidiInputPort *input_ = nullptr;    // us -> device
  std::mutex sendMutex_;
  std::thread reader_;
  std::atomic<bool> reading_{false};
  Forward forward_;

  std::mutex configMutex_;
  Shaping shaping_;
  Live live_;
  std::array<std::vector<uint8_t>, 16> ledDown_, ledUp_;

  // Reader thread only.
  struct LastHit {
    int64_t t = INT64_MIN;
    int velocity = 0;
  } last_[16];
  bool held_[16] = {};
  /** Setup held: the ATOM's own menu uses the pads, so they neither sound nor light. */
  bool setupHeld_ = false;
};

}  // namespace pad
