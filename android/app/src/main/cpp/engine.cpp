#include "engine.h"

#include <android/log.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <ctime>
#include <sstream>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "PadEngine", __VA_ARGS__)

namespace pad {

namespace {

constexpr float kStealFadeS = 0.008f;  // STEAL_FADE_S
constexpr float kClipKnee = 0.6f;      // CLIP_KNEE
constexpr int kMixFrames = 4096;

/** Same curve as softClip() in engine.ts. */
inline float softClip(float x) {
  float a = std::fabs(x);
  if (a <= kClipKnee) return x;
  const float head = 1 - kClipKnee;
  return std::copysign(kClipKnee + head * std::tanh((a - kClipKnee) / head), x);
}

/** velocityGain() in kit.ts. */
inline float velocityGain(int v) {
  float x = std::clamp(v, 0, 127) / 127.0f;
  return x * x;
}

struct LayerPick {
  int index;
  float gain;
};

/** selectLayers() in kit.ts. Returns the number of picks (1 or 2). */
int selectLayers(const std::vector<Layer> &layers, int velocity, float crossfade, LayerPick out[2]) {
  const int n = static_cast<int>(layers.size());
  if (n == 0) return 0;
  const int v = std::clamp(velocity, 1, 127);
  int index = n - 1;
  for (int i = 0; i < n; i++) {
    if (v <= layers[i].maxVelocity) {
      index = i;
      break;
    }
  }
  if (crossfade > 0) {
    const float half = crossfade / 2;
    int checks[2][2];
    int count = 0;
    if (index > 0) checks[count][0] = index - 1, checks[count++][1] = index;
    if (index < n - 1) checks[count][0] = index, checks[count++][1] = index + 1;
    for (int c = 0; c < count; c++) {
      const int lo = checks[c][0], hi = checks[c][1];
      const float boundary = layers[lo].maxVelocity + 0.5f;
      if (std::fabs(v - boundary) < half) {
        const float x = (v - (boundary - half)) / crossfade;
        out[0] = {lo, std::cos(x * static_cast<float>(M_PI) / 2)};
        out[1] = {hi, std::sin(x * static_cast<float>(M_PI) / 2)};
        return 2;
      }
    }
  }
  out[0] = {index, 1};
  return 1;
}

thread_local float tlMix[kBusCount][kMixFrames];

}  // namespace

int64_t nowNs() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
}

int Kit::instrumentIndex(const std::string &name) const {
  for (size_t i = 0; i < instruments.size(); i++)
    if (instruments[i].name == name) return static_cast<int>(i);
  return -1;
}

Engine &Engine::get() {
  static Engine engine;
  return engine;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------
void Engine::note(const std::string &s) {
  std::lock_guard<std::mutex> lock(historyMutex_);
  history_.push_back(s);
  if (history_.size() > 6) history_.erase(history_.begin());
}

bool Engine::openStream(const char *reason) {
  // The fast path (MMAP, exclusive) needs the MMAP policy on. On OnePlus/ColorOS the audio
  // service also only grants it to allow-listed package names (see android/README.md); anything
  // else silently gets the legacy mixer, which the Settings log then shows.
  oboe::OboeExtensions::setMMapEnabled(true);
  oboe::AudioStreamBuilder b;
  b.setDirection(oboe::Direction::Output)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::Float)
      ->setChannelCount(oboe::ChannelCount::Stereo)
      ->setSampleRate(48000)
      ->setDataCallback(this)
      ->setErrorCallback(this);
  std::shared_ptr<oboe::AudioStream> s;
  oboe::Result r = b.openStream(s);
  if (r != oboe::Result::OK) {
    note(std::string(reason) + ": open failed (" + oboe::convertToText(r) + ")");
    return false;
  }
  // One burst, the lowest possible; the callback's xrun check grows it if the device can't keep up.
  s->setBufferSizeInFrames(s->getFramesPerBurst());
  sampleRate_ = s->getSampleRate();
  framesRendered_ = 0;
  tsFrame_.store(-1);
  r = s->requestStart();
  if (r != oboe::Result::OK) {
    note(std::string(reason) + ": start failed (" + oboe::convertToText(r) + ")");
    s->close();
    return false;
  }
  stream_ = s;
  std::ostringstream log;
  log << reason << ": " << (oboe::OboeExtensions::isMMapUsed(s.get()) ? "MMAP" : "legacy")
      << (s->getSharingMode() == oboe::SharingMode::Exclusive ? " exclusive" : " shared") << ", burst "
      << s->getFramesPerBurst() << ", " << s->getSampleRate() << " Hz";
  note(log.str());
  LOG("%s", log.str().c_str());
  return true;
}

bool Engine::start() {
  std::lock_guard<std::mutex> lock(streamMutex_);
  if (running_) return true;
  if (!openStream("start")) return false;
  running_ = true;
  timestampThread_ = std::thread([this] { timestampLoop(); });
  return true;
}

void Engine::stop() {
  {
    std::lock_guard<std::mutex> lock(streamMutex_);
    if (!running_) return;
    running_ = false;
    if (stream_) {
      stream_->stop();
      stream_->close();
      stream_.reset();
    }
  }
  if (timestampThread_.joinable()) timestampThread_.join();
}

void Engine::onErrorAfterClose(oboe::AudioStream *, oboe::Result error) {
  // e.g. the output device changed: reopen on a fresh thread (not allowed from this callback's thread).
  LOG("stream closed: %s, reopening", oboe::convertToText(error));
  std::string reason = std::string("reopen after ") + oboe::convertToText(error);
  std::thread([this, reason] {
    std::lock_guard<std::mutex> lock(streamMutex_);
    stream_.reset();
    if (running_) openStream(reason.c_str());
  }).detach();
}

void Engine::timestampLoop() {
  while (running_) {
    std::shared_ptr<oboe::AudioStream> s;
    {
      std::lock_guard<std::mutex> lock(streamMutex_);
      s = stream_;
    }
    if (s) {
      auto ts = s->getTimestamp(CLOCK_MONOTONIC);
      if (ts) {
        tsSeq_.fetch_add(1);  // odd: writing
        tsFrame_.store(ts.value().position);
        tsNs_.store(ts.value().timestamp);
        tsSeq_.fetch_add(1);
        const int64_t written = s->getFramesWritten();
        const double heardAt = ts.value().timestamp + (written - ts.value().position) * 1e9 / sampleRate_;
        latencyMs_.store((heardAt - nowNs()) / 1e6);
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(tsFrame_.load() < 0 ? 5 : 50));
  }
}

std::string Engine::statusJson() {
  std::lock_guard<std::mutex> lock(streamMutex_);
  std::ostringstream o;
  if (!stream_) return "{\"running\":false}";
  auto *s = stream_.get();
  o << "{\"running\":true"
    << ",\"sampleRate\":" << s->getSampleRate() << ",\"framesPerBurst\":" << s->getFramesPerBurst()
    << ",\"bufferFrames\":" << s->getBufferSizeInFrames() << ",\"capacityFrames\":" << s->getBufferCapacityInFrames()
    << ",\"exclusive\":" << (s->getSharingMode() == oboe::SharingMode::Exclusive ? "true" : "false")
    << ",\"mmap\":" << (oboe::OboeExtensions::isMMapUsed(s) ? "true" : "false")
    << ",\"lowLatency\":" << (s->getPerformanceMode() == oboe::PerformanceMode::LowLatency ? "true" : "false")
    << ",\"latencyMs\":" << latencyMs_.load() << ",\"xruns\":" << xruns_.load() << ",\"opens\":[";
  {
    std::lock_guard<std::mutex> hl(historyMutex_);
    for (size_t i = 0; i < history_.size(); i++) {
      o << (i ? "," : "") << '"';
      for (char c : history_[i]) o << (c == '"' || c == '\\' ? '\'' : c);
      o << '"';
    }
  }
  o << "]}";
  return o.str();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const Sample *Engine::addSample(std::vector<float> mono, int rate) {
  auto s = std::make_unique<Sample>();
  if (rate == sampleRate_ || rate <= 0 || mono.empty()) {
    s->data = std::move(mono);
  } else {
    // Linear resampling at load time (kits are 48 kHz, so this is rarely used).
    const double step = static_cast<double>(rate) / sampleRate_;
    const size_t n = static_cast<size_t>((mono.size() - 1) / step) + 1;
    s->data.resize(n);
    for (size_t i = 0; i < n; i++) {
      const double x = i * step;
      const size_t j = static_cast<size_t>(x);
      const float f = static_cast<float>(x - j);
      const float a = mono[j], b = j + 1 < mono.size() ? mono[j + 1] : 0;
      s->data[i] = a + (b - a) * f;
    }
  }
  std::lock_guard<std::mutex> lock(dataMutex_);
  samples_.push_back(std::move(s));
  return samples_.back().get();
}

Kit *Engine::newKit(const std::string &id) {
  auto k = std::make_unique<Kit>();
  k->id = id;
  k->pads.fill(-1);
  std::lock_guard<std::mutex> lock(dataMutex_);
  kits_.push_back(std::move(k));
  return kits_.back().get();
}

Kit *Engine::findKit(const std::string &id) {
  std::lock_guard<std::mutex> lock(dataMutex_);
  for (auto &k : kits_)
    if (k->id == id) return k.get();
  return nullptr;
}

int Engine::chokeGroupId(const std::string &name) {
  if (name.empty()) return -1;
  std::lock_guard<std::mutex> lock(dataMutex_);
  auto it = chokeGroups_.find(name);
  if (it != chokeGroups_.end()) return it->second;
  const int id = static_cast<int>(chokeGroups_.size());
  chokeGroups_[name] = id;
  return id;
}

void Engine::setCue(const std::string &name, const Sample *s) {
  std::lock_guard<std::mutex> lock(dataMutex_);
  cues_[name] = s;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
void Engine::push(const Command &c) {
  std::lock_guard<std::mutex> lock(queueMutex_);
  queue_.push_back(c);
}

int Engine::playInstrument(const Kit *kit, int instrument, int velocity, int64_t heardNs) {
  if (!kit || instrument < 0 || instrument >= static_cast<int>(kit->instruments.size())) return 0;
  Command c{Command::kPlayInstrument};
  c.kit = kit;
  c.instrument = instrument;
  c.velocity = velocity;
  c.heardNs = heardNs;
  c.id = nextId();
  push(c);
  return c.id;
}

int Engine::playCue(const std::string &name, int bus, float gain, int64_t heardNs) {
  const Sample *s;
  {
    std::lock_guard<std::mutex> lock(dataMutex_);
    auto it = cues_.find(name);
    if (it == cues_.end()) return 0;
    s = it->second;
  }
  Command c{Command::kPlaySample};
  c.sample = s;
  c.bus = std::clamp(bus, 0, kBusCount - 1);
  c.value = gain;
  c.heardNs = heardNs;
  c.id = nextId();
  push(c);
  return c.id;
}

void Engine::stopVoice(int id) {
  Command c{Command::kStopVoice};
  c.id = id;
  push(c);
}

void Engine::stopAll() { push(Command{Command::kStopAll}); }

void Engine::synthNoteOn(int pad, int velocity, const SynthPatch &patch, float freq, int64_t heardNs) {
  Command c{Command::kSynthOn};
  c.pad = pad;
  c.velocity = velocity;
  c.patch = patch;
  c.freq = freq;
  c.heardNs = heardNs;
  push(c);
}

void Engine::synthPlay(int velocity, const SynthPatch &patch, float freq, int64_t heardNs, float holdS) {
  Command c{Command::kSynthOn};
  c.pad = -1;
  c.velocity = velocity;
  c.patch = patch;
  c.freq = freq;
  c.heardNs = heardNs;
  c.hold = holdS;
  push(c);
}

void Engine::synthNoteOff(int pad) {
  Command c{Command::kSynthOff};
  c.pad = pad;
  push(c);
}

void Engine::setMasterGain(float g) {
  Command c{Command::kMasterGain};
  c.value = g;
  push(c);
}

void Engine::setBusGain(int bus, float g) {
  Command c{Command::kBusGain};
  c.bus = std::clamp(bus, 0, kBusCount - 1);
  c.value = g;
  push(c);
}

int64_t Engine::frameFor(int64_t heardNs) const {
  if (heardNs <= 0) return 0;
  for (int attempt = 0; attempt < 4; attempt++) {
    const uint32_t s1 = tsSeq_.load();
    const int64_t f = tsFrame_.load();
    const int64_t t = tsNs_.load();
    if ((s1 & 1) || s1 != tsSeq_.load()) continue;
    if (f < 0) return 0;
    return f + static_cast<int64_t>(std::llround((heardNs - t) * static_cast<double>(sampleRate_) / 1e9));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Audio thread
// ---------------------------------------------------------------------------
void Engine::Biquad::lowpass(float freq, float q, float sr) {
  // RBJ cookbook low-pass, as Web Audio's BiquadFilterNode.
  const float w0 = 2 * static_cast<float>(M_PI) * std::min(freq, sr * 0.49f) / sr;
  const float alpha = std::sin(w0) / (2 * q);
  const float cw = std::cos(w0);
  const float a0 = 1 + alpha;
  b0 = (1 - cw) / 2 / a0;
  b1 = (1 - cw) / a0;
  b2 = b0;
  a1 = -2 * cw / a0;
  a2 = (1 - alpha) / a0;
  // State (z1, z2) is kept so a cutoff sweep stays click-free; new voices start from Biquad{}.
}

void Engine::release(Voice &v) {
  if (!v.active || v.releasing) return;
  if (!v.started) {
    v.active = false;
    return;
  }
  v.releasing = true;
  v.releaseLeft = static_cast<int>(kStealFadeS * 3 * sampleRate_);
}

void Engine::startVoice(const Sample *s, float gain, int bus, int chokeGroup, bool filter, float cutoff, int64_t frame, int id) {
  // The kit voice limit is applied when a voice starts (onAudioReady), so sounds scheduled
  // ahead never push each other out before they've played.
  Voice *slot = nullptr;
  for (auto &v : voices_) {
    if (!v.active) {
      slot = &v;
      break;
    }
  }
  if (!slot) {
    // Every slot busy: reuse the quietest tail, else the oldest voice.
    for (auto &v : voices_)
      if (v.releasing && (!slot || v.releaseLeft < slot->releaseLeft)) slot = &v;
    if (!slot) {
      for (auto &v : voices_)
        if (!slot || v.startFrame < slot->startFrame) slot = &v;
    }
  }
  Voice &v = *slot;
  v = Voice{};
  v.active = true;
  v.sample = s;
  v.startFrame = frame;
  v.gain = gain;
  v.bus = bus;
  v.chokeGroup = chokeGroup;
  v.id = id;
  v.filtered = filter;
  // Web Audio's default low-pass Q is 1 dB.
  if (filter) v.filter.lowpass(cutoff, std::pow(10.0f, 1.0f / 20), static_cast<float>(sampleRate_));
}

void Engine::apply(const Command &c) {
  switch (c.type) {
    case Command::kPlayInstrument: {
      const Instrument &inst = c.kit->instruments[c.instrument];
      const int64_t frame = frameFor(c.heardNs);
      const float base = velocityGain(c.velocity);
      const float vel = std::clamp(c.velocity, 0, 127) / 127.0f;
      const float cutoff = 600 + vel * vel * 16000;
      LayerPick picks[2];
      const int n = selectLayers(inst.layers, c.velocity, inst.crossfade, picks);
      for (int i = 0; i < n; i++) {
        const Layer &layer = inst.layers[picks[i].index];
        if (layer.variants.empty()) continue;
        const Sample *s = layer.variants[layer.next++ % layer.variants.size()];
        startVoice(s, base * picks[i].gain, kKitBus, inst.chokeGroup, inst.velocityFilter, cutoff, frame, c.id);
      }
      break;
    }
    case Command::kPlaySample:
      startVoice(c.sample, c.value, c.bus, -1, false, 0, frameFor(c.heardNs), c.id);
      break;
    case Command::kStopVoice:
      for (auto &v : voices_)
        if (v.active && v.id == c.id) {
          // A cancelled cue stops at once (source.stop() in engine.ts).
          v.active = false;
        }
      break;
    case Command::kStopAll:
      for (auto &v : voices_)
        if (v.bus == kKitBus) release(v);
      for (auto &v : synth_)
        if (v.active) releaseSynth(v, 0.02f);
      break;
    case Command::kSynthOn:
      startSynth(c);
      break;
    case Command::kSynthOff:
      for (auto &v : synth_)
        if (v.active && !v.releasing && v.pad == c.pad && v.patch.sustain > 0) releaseSynth(v, v.patch.release);
      break;
    case Command::kMasterGain:
      masterTarget_ = c.value;
      break;
    case Command::kBusGain:
      busTarget_[c.bus] = c.value;
      break;
  }
}

oboe::DataCallbackResult Engine::onAudioReady(oboe::AudioStream *stream, void *audioData, int32_t numFrames) {
  // Underruns: grow the buffer by a burst (up to 4 bursts) and keep going.
  auto xr = stream->getXRunCount();
  if (xr && xr.value() > xruns_.load()) {
    xruns_.store(xr.value());
    const int burst = stream->getFramesPerBurst();
    if (stream->getBufferSizeInFrames() < burst * 4) stream->setBufferSizeInFrames(stream->getBufferSizeInFrames() + burst);
  }
  // Render in the stream's own frame count, the one getTimestamp() positions (frameFor) use.
  // After an underrun AAudio skips that count ahead; counting only our own frames would fall
  // behind by every glitch, and scheduled sounds would start later and later, then never.
  const int64_t written = stream->getFramesWritten();
  if (written > framesRendered_) framesRendered_ = written;

  if (queueMutex_.try_lock()) {
    pending_.swap(queue_);
    queueMutex_.unlock();
    for (const auto &c : pending_) apply(c);
    pending_.clear();
  }

  auto *out = static_cast<float *>(audioData);
  const int channels = stream->getChannelCount();
  const float releaseK = std::exp(-1.0f / (kStealFadeS / 3 * sampleRate_));

  for (int done = 0; done < numFrames;) {
    const int n = std::min(numFrames - done, kMixFrames);
    const int64_t f0 = framesRendered_;
    for (auto &bus : tlMix) std::fill(bus, bus + n, 0.0f);

    for (auto &v : voices_) {
      if (!v.active) continue;
      int i = v.startFrame > f0 ? static_cast<int>(v.startFrame - f0) : 0;
      if (i >= n) continue;
      if (!v.started) {
        v.started = true;
        if (v.chokeGroup >= 0) {
          for (auto &o : voices_)
            if (&o != &v && o.active && o.started && o.chokeGroup == v.chokeGroup && o.id != v.id) release(o);
        }
        if (v.bus == kKitBus) {
          // Past the limit: the oldest sounding kit voice fades out (MAX_VOICES in engine.ts).
          int live = 0;
          Voice *oldest = nullptr;
          for (auto &o : voices_) {
            if (&o == &v || !o.active || !o.started || o.releasing || o.bus != kKitBus) continue;
            live++;
            if (!oldest || o.startFrame < oldest->startFrame) oldest = &o;
          }
          if (live >= kMaxKitVoices && oldest) release(*oldest);
        }
      }
      float *mix = tlMix[v.bus];
      const auto &data = v.sample->data;
      for (; i < n; i++) {
        if (v.pos >= data.size()) {
          v.active = false;
          break;
        }
        float x = data[v.pos++] * v.gain;
        if (v.filtered) x = v.filter.process(x);
        if (v.releasing) {
          x *= v.env;
          v.env *= releaseK;
          if (--v.releaseLeft <= 0) {
            v.active = false;
            mix[i] += x;
            break;
          }
        }
        mix[i] += x;
      }
    }

    for (auto &v : synth_) {
      if (!v.active) continue;
      const int from = v.startFrame > f0 ? static_cast<int>(v.startFrame - f0) : 0;
      if (from < n) renderSynth(v, tlMix[kSynthBus], from, n);
    }

    // Gain changes glide over ~10 ms (setTargetAtTime(…, 0.01) in engine.ts).
    const float glide = 1 - std::exp(-static_cast<float>(n) / (0.01f * sampleRate_));
    for (int b = 0; b < kBusCount; b++) busGain_[b] += (busTarget_[b] - busGain_[b]) * glide;
    master_ += (masterTarget_ - master_) * glide;

    const size_t base = static_cast<size_t>(done) * channels;
    for (int i = 0; i < n; i++) {
      const float x = softClip(master_ * (tlMix[kKitBus][i] * busGain_[kKitBus] + tlMix[kMetronomeBus][i] * busGain_[kMetronomeBus] +
                                          tlMix[kCueBus][i] * busGain_[kCueBus] + tlMix[kSynthBus][i] * busGain_[kSynthBus]));
      const size_t at = base + static_cast<size_t>(i) * channels;
      for (int ch = 0; ch < channels; ch++) out[at + ch] = x;
    }
    framesRendered_ += n;
    done += n;
  }
  return oboe::DataCallbackResult::Continue;
}

// ---------------------------------------------------------------------------
// Synth (port of SynthVoices in src/audio/synth.ts)
// ---------------------------------------------------------------------------
namespace {
/** Time constant for a 60 dB fall over `t` seconds (tc60 in synth.ts). */
inline float tc60(float t) { return std::max(0.001f, t / 6.9f); }
/** Per-sample factor of an exponential approach with time constant `tc` seconds. */
inline float expK(float tc, int sr) { return std::exp(-1.0f / (tc * sr)); }
/** Square and saw are much louder than sine at the same amplitude (WAVE_GAIN). */
constexpr float kWaveGain[4] = {1, 1, 0.45f, 0.55f};

/** PolyBLEP correction: band-limits the jumps of the naive square and saw. */
inline double polyBlep(double t, double dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

inline float oscillator(int wave, double ph, double dt) {
  switch (wave) {
    case 0: return static_cast<float>(std::sin(2 * M_PI * ph));
    case 2: {
      double v = ph < 0.5 ? 1 : -1;
      v += polyBlep(ph, dt);
      v -= polyBlep(std::fmod(ph + 0.5, 1.0), dt);
      return static_cast<float>(v);
    }
    case 3: return static_cast<float>(2 * ph - 1 - polyBlep(ph, dt));
    default: return static_cast<float>(4 * std::fabs(ph - 0.5) - 1);  // triangle
  }
}
}  // namespace

void Engine::releaseSynth(SynthVoice &v, float seconds) {
  if (!v.active || v.releasing) return;
  if (!v.started) {
    v.active = false;
    return;
  }
  v.releasing = true;
  v.releaseK = expK(tc60(seconds), sampleRate_);
  v.stopAt = v.age + static_cast<int64_t>((seconds * 1.2f + 0.02f) * sampleRate_);
}

void Engine::startSynth(const Command &c) {
  const SynthPatch &p = c.patch;
  // Same pad: release the previous note quickly; past the voice limit: steal the oldest.
  // Scheduled notes (pad -1) are queued ahead and never steal: they only take free slots.
  int live = 0;
  SynthVoice *oldest = nullptr;
  for (auto &v : synth_) {
    if (!v.active || v.releasing || c.pad < 0) continue;
    if (v.pad == c.pad) {
      releaseSynth(v, 0.03f);
      continue;
    }
    live++;
    if (!oldest || v.startFrame < oldest->startFrame) oldest = &v;
  }
  if (live >= kMaxSynthVoices && oldest) releaseSynth(*oldest, 0.01f);

  SynthVoice *slot = nullptr;
  for (auto &v : synth_)
    if (!v.active) {
      slot = &v;
      break;
    }
  if (!slot) {
    if (c.pad < 0) return;
    for (auto &v : synth_)
      if (!slot || v.startFrame < slot->startFrame) slot = &v;
  }
  SynthVoice &v = *slot;
  v = SynthVoice{};
  v.active = true;
  v.pad = c.pad;
  v.patch = p;
  v.startFrame = frameFor(c.heardNs);
  const float sr = static_cast<float>(sampleRate_);
  const float vel = std::clamp(c.velocity, 1, 127) / 127.0f;
  v.peak = 0.5f * p.level * kWaveGain[std::clamp(p.wave, 0, 3)] * vel * vel / (p.detune > 0 ? 1.4f : 1);
  v.oscs = p.detune > 0 ? 2 : 1;
  const double cents[2] = {p.detune > 0 ? -p.detune / 2 : 0, p.detune / 2};
  for (int i = 0; i < v.oscs; i++) {
    v.inc[i] = c.freq * std::pow(2.0, cents[i] / 1200) / sr;
    v.phase[i] = 0;
  }
  v.attackFrames = std::max(0.002f, p.attack) * sr;
  v.sustainLevel = v.peak * p.sustain;
  v.decayK = expK(tc60(p.decay), sampleRate_);
  // Softer hits sound darker; the filter opens at the start and closes over the decay.
  v.base = std::clamp(p.cutoff * (0.45f + 0.55f * vel), 40.0f, 20000.0f);
  v.cut = std::clamp(v.base * (1 + p.filterEnv * 15), 40.0f, 20000.0f);
  v.cutK = expK(tc60(p.decay) * 1.5f, sampleRate_);
  // Web Audio's low-pass Q is in dB.
  v.q = std::pow(10.0f, p.resonance / 20);
  v.filter.lowpass(v.cut, v.q, sr);
  // Notes without sustain end by themselves; held notes wait for note-off.
  if (p.sustain == 0) v.stopAt = static_cast<int64_t>((p.attack + p.decay * 1.3f + 0.05f) * sr);
  else if (c.pad < 0) v.releaseAt = static_cast<int64_t>(std::max(c.hold, p.attack) * sr);
}

void Engine::renderSynth(SynthVoice &v, float *mix, int from, int n) {
  const float sr = static_cast<float>(sampleRate_);
  const int64_t attackEnd = static_cast<int64_t>(v.patch.attack * sr);
  for (int i = from; i < n; i++) {
    if (!v.started) v.started = true;
    if (v.stopAt >= 0 && v.age >= v.stopAt) {
      v.active = false;
      return;
    }
    if (v.releaseAt >= 0 && v.age >= v.releaseAt && !v.releasing) releaseSynth(v, v.patch.release);
    // Amplitude: linear attack, then exponential decay towards sustain; release falls to 0.
    if (v.releasing) {
      v.env *= v.releaseK;
    } else if (v.age < v.attackFrames) {
      v.env = v.peak * (v.age / v.attackFrames);
    } else {
      v.env = v.sustainLevel + (v.env - v.sustainLevel) * v.decayK;
    }
    // Filter envelope: held open through the attack, then closes towards the base cutoff.
    if (v.age >= attackEnd && v.cut > v.base) {
      v.cut = v.base + (v.cut - v.base) * v.cutK;
      if ((v.age & 15) == 0) v.filter.lowpass(v.cut, v.q, sr);
    }
    float x = 0;
    for (int o = 0; o < v.oscs; o++) {
      x += oscillator(v.patch.wave, v.phase[o], v.inc[o]);
      v.phase[o] += v.inc[o];
      if (v.phase[o] >= 1) v.phase[o] -= 1;
    }
    mix[i] += v.filter.process(x) * v.env;
    v.age++;
  }
}

}  // namespace pad
