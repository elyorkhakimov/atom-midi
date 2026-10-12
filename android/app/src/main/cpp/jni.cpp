// JNI entry points for net.padgames.app.NativeEngine.
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <jni.h>

#include <cstring>
#include <string>
#include <vector>

#include "engine.h"
#include "midi.h"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "PadJni", __VA_ARGS__)

using pad::Engine;
using pad::Kit;
using pad::Midi;

namespace {

JavaVM *gVm = nullptr;
AAssetManager *gAssets = nullptr;
jclass gEngineClass = nullptr;
jmethodID gOnMidi = nullptr;

/** Attaches the MIDI reader thread to the JVM once; detaches when the thread exits. */
struct ThreadEnv {
  JNIEnv *env = nullptr;
  ~ThreadEnv() {
    if (env) gVm->DetachCurrentThread();
  }
  JNIEnv *get() {
    if (!env) {
      JavaVMAttachArgs args{JNI_VERSION_1_6, "PadMidiReader", nullptr};
      gVm->AttachCurrentThread(&env, &args);
    }
    return env;
  }
};
thread_local ThreadEnv tEnv;

std::string str(JNIEnv *env, jstring s) {
  if (!s) return {};
  const char *c = env->GetStringUTFChars(s, nullptr);
  std::string out(c);
  env->ReleaseStringUTFChars(s, c);
  return out;
}

uint32_t le32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | static_cast<uint32_t>(p[3]) << 24; }
uint16_t le16(const uint8_t *p) { return p[0] | p[1] << 8; }

/** Reads a PCM (16/24/32-bit int or 32-bit float) WAV from the APK assets, mixed to mono. */
bool loadWav(const std::string &path, std::vector<float> &out, int &rate) {
  AAsset *a = AAssetManager_open(gAssets, path.c_str(), AASSET_MODE_BUFFER);
  if (!a) {
    LOG("missing asset %s", path.c_str());
    return false;
  }
  const auto *p = static_cast<const uint8_t *>(AAsset_getBuffer(a));
  const size_t size = AAsset_getLength(a);
  bool ok = false;
  if (p && size >= 12 && !memcmp(p, "RIFF", 4) && !memcmp(p + 8, "WAVE", 4)) {
    int format = 0, channels = 0, bits = 0;
    for (size_t off = 12; off + 8 <= size;) {
      const uint32_t len = le32(p + off + 4);
      const uint8_t *body = p + off + 8;
      if (!memcmp(p + off, "fmt ", 4) && len >= 16) {
        format = le16(body);
        channels = le16(body + 2);
        rate = static_cast<int>(le32(body + 4));
        bits = le16(body + 14);
        if (format == 0xFFFE && len >= 26) format = le16(body + 24);  // WAVE_FORMAT_EXTENSIBLE
      } else if (!memcmp(p + off, "data", 4) && channels > 0) {
        const size_t bytes = std::min<size_t>(len, size - off - 8);
        const int bps = bits / 8;
        const size_t frames = bytes / (bps * channels);
        out.assign(frames, 0);
        for (size_t f = 0; f < frames; f++) {
          float sum = 0;
          for (int c = 0; c < channels; c++) {
            const uint8_t *s = body + (f * channels + c) * bps;
            float v = 0;
            if (format == 3 && bits == 32) memcpy(&v, s, 4);
            else if (bits == 16) v = static_cast<int16_t>(le16(s)) / 32768.0f;
            else if (bits == 24) v = static_cast<int32_t>(static_cast<uint32_t>(s[0] << 8 | s[1] << 16 | s[2] << 24)) / 2147483648.0f;
            else if (bits == 32) v = static_cast<int32_t>(le32(s)) / 2147483648.0f;
            sum += v;
          }
          out[f] = sum / channels;
        }
        ok = format == 1 || format == 3;
        break;
      }
      off += 8 + len + (len & 1);
    }
  }
  AAsset_close(a);
  if (!ok) LOG("unsupported WAV %s", path.c_str());
  return ok;
}

}  // namespace

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
  gVm = vm;
  JNIEnv *env;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
  jclass c = env->FindClass("net/padgames/app/NativeEngine");
  gEngineClass = static_cast<jclass>(env->NewGlobalRef(c));
  gOnMidi = env->GetStaticMethodID(gEngineClass, "onMidi", "([BJ)V");
  return JNI_VERSION_1_6;
}

#define FN(name) Java_net_padgames_app_NativeEngine_##name

JNIEXPORT jboolean JNICALL FN(start)(JNIEnv *env, jclass, jobject assets) {
  gAssets = AAssetManager_fromJava(env, env->NewGlobalRef(assets));
  return Engine::get().start();
}

JNIEXPORT void JNICALL FN(stop)(JNIEnv *, jclass) { Engine::get().stop(); }

JNIEXPORT jstring JNICALL FN(statusJson)(JNIEnv *env, jclass) { return env->NewStringUTF(Engine::get().statusJson().c_str()); }

JNIEXPORT jdouble JNICALL FN(latencyMs)(JNIEnv *, jclass) { return Engine::get().latencyMs(); }

JNIEXPORT jlong JNICALL FN(nowNs)(JNIEnv *, jclass) { return pad::nowNs(); }

// --- Kits -------------------------------------------------------------------
JNIEXPORT jlong JNICALL FN(kitCreate)(JNIEnv *env, jclass, jstring id) {
  return reinterpret_cast<jlong>(Engine::get().newKit(str(env, id)));
}

JNIEXPORT jint JNICALL FN(kitAddInstrument)(JNIEnv *env, jclass, jlong kit, jstring name, jstring choke, jfloat crossfade,
                                           jboolean velocityFilter) {
  auto *k = reinterpret_cast<Kit *>(kit);
  pad::Instrument inst;
  inst.name = str(env, name);
  inst.chokeGroup = Engine::get().chokeGroupId(str(env, choke));
  inst.crossfade = crossfade;
  inst.velocityFilter = velocityFilter;
  k->instruments.push_back(std::move(inst));
  return static_cast<jint>(k->instruments.size() - 1);
}

JNIEXPORT jboolean JNICALL FN(kitAddLayer)(JNIEnv *env, jclass, jlong kit, jint instrument, jint minVel, jint maxVel,
                                          jobjectArray paths) {
  auto *k = reinterpret_cast<Kit *>(kit);
  pad::Layer layer;
  layer.minVelocity = minVel;
  layer.maxVelocity = maxVel;
  const jsize n = env->GetArrayLength(paths);
  for (jsize i = 0; i < n; i++) {
    auto *js = static_cast<jstring>(env->GetObjectArrayElement(paths, i));
    std::vector<float> pcm;
    int rate = 0;
    const bool ok = loadWav(str(env, js), pcm, rate);
    env->DeleteLocalRef(js);
    if (!ok) return false;
    layer.variants.push_back(Engine::get().addSample(std::move(pcm), rate));
  }
  k->instruments[instrument].layers.push_back(std::move(layer));
  return true;
}

JNIEXPORT void JNICALL FN(kitSetPad)(JNIEnv *, jclass, jlong kit, jint pad, jint instrument) {
  auto *k = reinterpret_cast<Kit *>(kit);
  if (pad >= 0 && pad < 16) k->pads[pad] = instrument;
}

JNIEXPORT void JNICALL FN(kitSelect)(JNIEnv *, jclass, jlong kit) { Engine::get().setCurrentKit(reinterpret_cast<Kit *>(kit)); }

// --- Playback ---------------------------------------------------------------
JNIEXPORT jint JNICALL FN(playInstrument)(JNIEnv *env, jclass, jstring name, jint velocity, jlong heardNs) {
  Engine &e = Engine::get();
  const Kit *kit = e.currentKit();
  if (!kit) return 0;
  return e.playInstrument(kit, kit->instrumentIndex(str(env, name)), velocity, heardNs);
}

JNIEXPORT jint JNICALL FN(playKitInstrument)(JNIEnv *env, jclass, jstring kitId, jstring name, jint velocity, jlong heardNs) {
  Engine &e = Engine::get();
  const Kit *kit = e.findKit(str(env, kitId));
  if (!kit) return 0;
  return e.playInstrument(kit, kit->instrumentIndex(str(env, name)), velocity, heardNs);
}

JNIEXPORT void JNICALL FN(setCue)(JNIEnv *env, jclass, jstring name, jfloatArray pcm, jint rate) {
  std::vector<float> data(env->GetArrayLength(pcm));
  env->GetFloatArrayRegion(pcm, 0, static_cast<jsize>(data.size()), data.data());
  Engine &e = Engine::get();
  e.setCue(str(env, name), e.addSample(std::move(data), rate));
}

JNIEXPORT jint JNICALL FN(playCue)(JNIEnv *env, jclass, jstring name, jint bus, jfloat gain, jlong heardNs) {
  return Engine::get().playCue(str(env, name), bus, gain, heardNs);
}

JNIEXPORT void JNICALL FN(stopVoice)(JNIEnv *, jclass, jint id) { Engine::get().stopVoice(id); }
JNIEXPORT void JNICALL FN(stopAll)(JNIEnv *, jclass) { Engine::get().stopAll(); }
JNIEXPORT void JNICALL FN(setMasterGain)(JNIEnv *, jclass, jfloat g) { Engine::get().setMasterGain(g); }
JNIEXPORT void JNICALL FN(setBusGain)(JNIEnv *, jclass, jint bus, jfloat g) { Engine::get().setBusGain(bus, g); }

// --- MIDI -------------------------------------------------------------------
JNIEXPORT jboolean JNICALL FN(midiOpen)(JNIEnv *env, jclass, jobject device) {
  return Midi::get().open(env, device, [](const uint8_t *data, size_t len, int64_t ts) {
    // Reader thread: hand each message to Kotlin.
    JNIEnv *tenv = tEnv.get();
    jbyteArray arr = tenv->NewByteArray(static_cast<jsize>(len));
    tenv->SetByteArrayRegion(arr, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte *>(data));
    tenv->CallStaticVoidMethod(gEngineClass, gOnMidi, arr, static_cast<jlong>(ts));
    tenv->DeleteLocalRef(arr);
  });
}

JNIEXPORT void JNICALL FN(midiClose)(JNIEnv *, jclass) { Midi::get().close(); }

JNIEXPORT jboolean JNICALL FN(midiSend)(JNIEnv *env, jclass, jbyteArray bytes) {
  std::vector<uint8_t> data(env->GetArrayLength(bytes));
  env->GetByteArrayRegion(bytes, 0, static_cast<jsize>(data.size()), reinterpret_cast<jbyte *>(data.data()));
  return Midi::get().send(data.data(), data.size());
}

namespace {
/** [wave, detune, attack, decay, sustain, release, cutoff, resonance, filterEnv, level] */
pad::SynthPatch patchFrom(JNIEnv *env, jfloatArray arr) {
  float v[10] = {1, 0, 0.002f, 0.35f, 0, 0.1f, 12000, 0, 0, 0.8f};
  if (arr) env->GetFloatArrayRegion(arr, 0, std::min<jsize>(10, env->GetArrayLength(arr)), v);
  pad::SynthPatch p;
  p.wave = static_cast<int>(v[0]);
  p.detune = v[1];
  p.attack = v[2];
  p.decay = v[3];
  p.sustain = v[4];
  p.release = v[5];
  p.cutoff = v[6];
  p.resonance = v[7];
  p.filterEnv = v[8];
  p.level = v[9];
  return p;
}
}  // namespace

JNIEXPORT void JNICALL FN(setLive)(JNIEnv *env, jclass, jint mask, jint fixedVelocity, jboolean synth, jfloatArray patch,
                                   jfloatArray freqs) {
  Midi::Live live;
  live.mask = static_cast<uint32_t>(mask);
  live.fixedVelocity = fixedVelocity;
  live.synth = synth;
  live.patch = patchFrom(env, patch);
  if (freqs) env->GetFloatArrayRegion(freqs, 0, std::min<jsize>(16, env->GetArrayLength(freqs)), live.freqs.data());
  Midi::get().setLive(live);
}

/** Per pad: [downLength, down bytes…, upLength, up bytes…], pads 0–15 in order. */
JNIEXPORT void JNICALL FN(setHitLeds)(JNIEnv *env, jclass, jbyteArray packed) {
  std::vector<uint8_t> b(env->GetArrayLength(packed));
  env->GetByteArrayRegion(packed, 0, static_cast<jsize>(b.size()), reinterpret_cast<jbyte *>(b.data()));
  std::array<std::vector<uint8_t>, 16> down, up;
  size_t i = 0;
  for (int pad = 0; pad < 16 && i < b.size(); pad++) {
    for (auto *dst : {&down[pad], &up[pad]}) {
      const size_t n = i < b.size() ? b[i++] : 0;
      if (i + n > b.size()) return;
      dst->assign(b.begin() + static_cast<long>(i), b.begin() + static_cast<long>(i + n));
      i += n;
    }
  }
  Midi::get().setHitLeds(down, up);
}

JNIEXPORT void JNICALL FN(synthNoteOn)(JNIEnv *env, jclass, jint pad, jint velocity, jfloatArray patch, jfloat freq, jlong heardNs) {
  Engine::get().synthNoteOn(pad, velocity, patchFrom(env, patch), freq, heardNs);
}

JNIEXPORT void JNICALL FN(synthPlay)(JNIEnv *env, jclass, jint velocity, jfloatArray patch, jfloat freq, jlong heardNs, jfloat holdS) {
  Engine::get().synthPlay(velocity, patchFrom(env, patch), freq, heardNs, holdS);
}

JNIEXPORT void JNICALL FN(synthNoteOff)(JNIEnv *, jclass, jint pad) { Engine::get().synthNoteOff(pad); }

JNIEXPORT void JNICALL FN(setShaping)(JNIEnv *, jclass, jint threshold, jfloat gamma, jint doubleTriggerMs) {
  Midi::get().setShaping({threshold, gamma, doubleTriggerMs});
}

}  // extern "C"
