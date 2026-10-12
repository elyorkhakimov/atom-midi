// Native port of src/audio/engine.ts: sample kits with velocity layers, crossfades,
// round-robin, choke groups and voice stealing; cue/metronome buffers; kit, metronome
// and cue buses into a soft clipper. Output runs on Oboe (AAudio, exclusive low latency).
//
// Threads: the audio callback owns all voice state. Other threads (MIDI reader, JS bridge)
// talk to it through a command queue. Samples and kits are never freed once loaded, so the
// audio thread can hold plain pointers to them.
#pragma once

#include <oboe/Oboe.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace pad {

/** Mono PCM at the engine's sample rate. */
struct Sample {
  std::vector<float> data;
};

struct Layer {
  int minVelocity = 1;
  int maxVelocity = 127;
  std::vector<const Sample *> variants;
  /** Round-robin position; audio thread only. */
  mutable int next = 0;
};

struct Instrument {
  std::string name;
  int chokeGroup = -1;
  float crossfade = 0;
  bool velocityFilter = false;
  std::vector<Layer> layers;
};

struct Kit {
  std::string id;
  std::vector<Instrument> instruments;
  /** Instrument index per pad, -1 = none. */
  std::array<int, 16> pads{};
  int instrumentIndex(const std::string &name) const;
};

enum Bus : int { kKitBus = 0, kMetronomeBus = 1, kCueBus = 2, kSynthBus = 3, kBusCount = 4 };

/** SynthPatch in src/audio/synth.ts (wave: 0 sine, 1 triangle, 2 square, 3 sawtooth). */
struct SynthPatch {
  int wave = 1;
  float detune = 0;  // cents between the two oscillators; 0 = one oscillator
  float attack = 0.002f, decay = 0.35f, sustain = 0, release = 0.1f;  // seconds / 0..1
  float cutoff = 12000, resonance = 0, filterEnv = 0, level = 0.8f;   // Hz / dB / 0..1 / 0..1
};

/** Monotonic clock (CLOCK_MONOTONIC), the domain of MIDI timestamps and Oboe timestamps. */
int64_t nowNs();

class Engine : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
 public:
  static Engine &get();

  bool start();
  void stop();
  int sampleRate() const { return sampleRate_; }
  /** Engine status as JSON (stream settings, latency, xruns). */
  std::string statusJson();
  /** Time from rendering a frame to hearing it, per Oboe's output timestamps. */
  double latencyMs() const { return latencyMs_.load(); }

  // Loading (any thread except audio). Resamples to the engine rate.
  const Sample *addSample(std::vector<float> mono, int sampleRate);
  Kit *newKit(const std::string &id);
  Kit *findKit(const std::string &id);
  void setCurrentKit(Kit *kit) { currentKit_.store(kit); }
  Kit *currentKit() const { return currentKit_.load(); }
  int chokeGroupId(const std::string &name);
  void setCue(const std::string &name, const Sample *s);

  // Playback (any thread). heardNs = when it should be heard; 0 or past = as soon as possible.
  // Returns a voice id for stopVoice.
  int playInstrument(const Kit *kit, int instrument, int velocity, int64_t heardNs);
  int playCue(const std::string &name, int bus, float gain, int64_t heardNs);
  void stopVoice(int id);
  /** Releases kit and synth voices (leaving a game or page). */
  void stopAll();
  /** Synth note for a pad at `freq` Hz; a new note on the same pad releases the old one. */
  void synthNoteOn(int pad, int velocity, const SynthPatch &patch, float freq, int64_t heardNs);
  /** A scheduled note on no pad (Beat maker): sustaining patches release after `holdS`. */
  void synthPlay(int velocity, const SynthPatch &patch, float freq, int64_t heardNs, float holdS);
  /** Releases the pad's held notes (notes without sustain ring out by themselves). */
  void synthNoteOff(int pad);
  void setMasterGain(float g);
  void setBusGain(int bus, float g);

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream *stream, void *audioData, int32_t numFrames) override;
  void onErrorAfterClose(oboe::AudioStream *stream, oboe::Result error) override;

 private:
  Engine() = default;

  struct Command {
    enum Type { kPlayInstrument, kPlaySample, kStopVoice, kStopAll, kMasterGain, kBusGain, kSynthOn, kSynthOff } type;
    const Kit *kit = nullptr;
    int instrument = 0;
    int velocity = 0;
    const Sample *sample = nullptr;
    int bus = kKitBus;
    float value = 1;
    int64_t heardNs = 0;
    int id = 0;
    int pad = 0;
    float freq = 0;
    /** kSynthOn without a pad (-1): seconds until release; 0 = held until note-off. */
    float hold = 0;
    SynthPatch patch;
  };

  struct Biquad {
    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    void lowpass(float freq, float q, float sr);
    float process(float x) {
      float y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      return y;
    }
  };

  struct Voice {
    bool active = false;
    const Sample *sample = nullptr;
    int64_t startFrame = 0;
    size_t pos = 0;
    float gain = 1;
    int bus = kKitBus;
    int chokeGroup = -1;
    bool filtered = false;
    Biquad filter;
    bool releasing = false;
    float env = 1;
    int releaseLeft = 0;
    int id = 0;
    /** Choke handling waits until the voice actually starts. */
    bool started = false;
  };

  /** One SynthVoices voice in synth.ts: 1–2 oscillators -> low-pass -> ADSR. */
  struct SynthVoice {
    bool active = false;
    bool started = false;
    bool releasing = false;
    int pad = 0;
    int64_t startFrame = 0;
    int64_t age = 0;       // frames since start
    int64_t stopAt = -1;   // frames since start; -1 = held until released
    int64_t releaseAt = -1;  // frames since start to begin the release (scheduled notes)
    SynthPatch patch;
    double phase[2] = {0, 0};
    double inc[2] = {0, 0};
    int oscs = 1;
    float peak = 0, env = 0, attackFrames = 1, decayK = 0, sustainLevel = 0, releaseK = 0;
    float base = 0, cut = 0, cutK = 0, q = 1;
    Biquad filter;
  };

  static constexpr int kMaxSynthVoices = 16;  // MAX_SYNTH_VOICES in synth.ts
  static constexpr int kSynthSlots = 32;
  void startSynth(const Command &c);
  void releaseSynth(SynthVoice &v, float seconds);
  void renderSynth(SynthVoice &v, float *mix, int from, int n);

  static constexpr int kMaxKitVoices = 32;  // MAX_VOICES in engine.ts
  static constexpr int kVoiceSlots = 96;     // + releasing tails and cues

  void push(const Command &c);
  int nextId() { return nextVoiceId_.fetch_add(1) + 1; }
  void apply(const Command &c);
  int64_t frameFor(int64_t heardNs) const;
  void startVoice(const Sample *s, float gain, int bus, int chokeGroup, bool filter, float cutoff, int64_t frame, int id);
  void release(Voice &v);
  void timestampLoop();
  bool openStream(const char *reason);
  void note(const std::string &s);

  // Stream and configuration
  std::shared_ptr<oboe::AudioStream> stream_;
  std::mutex streamMutex_;
  int sampleRate_ = 48000;
  std::atomic<bool> running_{false};
  std::thread timestampThread_;

  // Loaded data (never freed)
  std::mutex dataMutex_;
  std::deque<std::unique_ptr<Sample>> samples_;
  std::deque<std::unique_ptr<Kit>> kits_;
  std::map<std::string, int> chokeGroups_;
  std::map<std::string, const Sample *> cues_;
  std::atomic<Kit *> currentKit_{nullptr};

  // Commands
  std::mutex queueMutex_;
  std::vector<Command> queue_;
  std::vector<Command> pending_;  // audio thread only
  std::atomic<int> nextVoiceId_{0};

  // Audio thread state
  std::array<Voice, kVoiceSlots> voices_{};
  std::array<SynthVoice, kSynthSlots> synth_{};
  int64_t framesRendered_ = 0;
  float busGain_[kBusCount] = {0.55f, 0.7f, 0.8f, 0.55f};
  float busTarget_[kBusCount] = {0.55f, 0.7f, 0.8f, 0.55f};
  float master_ = 1, masterTarget_ = 1;

  // Clock mapping from the timestamp thread: frame `tsFrame_` was heard at `tsNs_`.
  // Written under a sequence counter so the audio thread never reads a torn pair.
  std::atomic<uint32_t> tsSeq_{0};
  std::atomic<int64_t> tsFrame_{-1};
  std::atomic<int64_t> tsNs_{0};
  std::atomic<double> latencyMs_{0};
  std::atomic<int> xruns_{0};
  /** What each stream open tried and got, for the Settings screen. */
  std::mutex historyMutex_;
  std::vector<std::string> history_;
};

}  // namespace pad
