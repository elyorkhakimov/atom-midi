package net.padgames.app

import android.content.res.AssetManager
import android.media.midi.MidiDevice

/** JNI surface of libpadengine (src/main/cpp). */
object NativeEngine {
    init {
        System.loadLibrary("padengine")
    }

    /** Receives every MIDI message from the reader thread (after live pads have already sounded). */
    @Volatile
    var midiListener: ((ByteArray, Long) -> Unit)? = null

    @JvmStatic
    fun onMidi(data: ByteArray, timestampNs: Long) {
        midiListener?.invoke(data, timestampNs)
    }

    @JvmStatic external fun start(assets: AssetManager): Boolean
    @JvmStatic external fun stop()
    @JvmStatic external fun statusJson(): String
    @JvmStatic external fun latencyMs(): Double
    @JvmStatic external fun nowNs(): Long

    @JvmStatic external fun kitCreate(id: String): Long
    @JvmStatic external fun kitAddInstrument(kit: Long, name: String, chokeGroup: String, crossfade: Float, velocityFilter: Boolean): Int
    @JvmStatic external fun kitAddLayer(kit: Long, instrument: Int, minVelocity: Int, maxVelocity: Int, paths: Array<String>): Boolean
    @JvmStatic external fun kitSetPad(kit: Long, pad: Int, instrument: Int)
    @JvmStatic external fun kitSelect(kit: Long)

    @JvmStatic external fun playInstrument(name: String, velocity: Int, heardNs: Long): Int
    /** An instrument of any loaded kit (by kit id), not just the current one. */
    @JvmStatic external fun playKitInstrument(kitId: String, name: String, velocity: Int, heardNs: Long): Int
    @JvmStatic external fun setCue(name: String, pcm: FloatArray, sampleRate: Int)
    @JvmStatic external fun playCue(name: String, bus: Int, gain: Float, heardNs: Long): Int
    @JvmStatic external fun stopVoice(id: Int)
    @JvmStatic external fun stopAll()
    @JvmStatic external fun setMasterGain(gain: Float)
    @JvmStatic external fun setBusGain(bus: Int, gain: Float)

    @JvmStatic external fun midiOpen(device: MidiDevice): Boolean
    @JvmStatic external fun midiClose()
    @JvmStatic external fun midiSend(bytes: ByteArray): Boolean
    /** patch = [wave, detune, attack, decay, sustain, release, cutoff, resonance, filterEnv, level] */
    @JvmStatic external fun setLive(mask: Int, fixedVelocity: Int, synth: Boolean, patch: FloatArray?, freqs: FloatArray?)
    @JvmStatic external fun setHitLeds(packed: ByteArray)
    @JvmStatic external fun synthNoteOn(pad: Int, velocity: Int, patch: FloatArray, freq: Float, heardNs: Long)
    @JvmStatic external fun synthNoteOff(pad: Int)
    @JvmStatic external fun setShaping(threshold: Int, gamma: Float, doubleTriggerMs: Int)
}
