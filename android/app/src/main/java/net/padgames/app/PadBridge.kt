package net.padgames.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

/**
 * `window.PadNative` in the page (see src/native/bridge.ts). Calls arrive on the WebView's
 * JavaBridge thread; replies go back through `window.__padNative` on the main thread.
 * Times are CLOCK_MONOTONIC nanoseconds, passed as JS numbers.
 */
class PadBridge(private val context: Context, private val webView: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val loader = Executors.newSingleThreadExecutor()
    private val kits = HashMap<String, Long>()
    @Volatile private var midiName: String? = null
    private val midiBatch = StringBuilder()
    private var midiFlushPosted = false

    private fun js(code: String) {
        main.post { webView.evaluateJavascript("window.__padNative && window.__padNative.$code", null) }
    }

    // --- Native -> page -----------------------------------------------------
    /** Messages are batched per main-thread turn, so pressure streams don't flood the page. */
    fun forwardMidi(data: ByteArray, timestampNs: Long) {
        val bytes = data.joinToString(",") { (it.toInt() and 0xFF).toString() }
        synchronized(midiBatch) {
            if (midiBatch.isNotEmpty()) midiBatch.append(',')
            midiBatch.append("[[").append(bytes).append("],").append(timestampNs).append(']')
            if (midiFlushPosted) return
            midiFlushPosted = true
        }
        main.post {
            val batch = synchronized(midiBatch) {
                midiFlushPosted = false
                midiBatch.toString().also { midiBatch.setLength(0) }
            }
            webView.evaluateJavascript("window.__padNative && window.__padNative.midi([$batch])", null)
        }
    }

    fun midiState(connected: Boolean, name: String?) {
        midiName = if (connected) name else null
        js("midiState($connected,${JSONObject.quote(name ?: "")})")
    }

    // --- Page -> native -----------------------------------------------------
    @JavascriptInterface fun nowNs(): Double = NativeEngine.nowNs().toDouble()

    @JavascriptInterface fun latencyMs(): Double = NativeEngine.latencyMs()

    @JavascriptInterface
    fun status(): String = JSONObject()
        .put("audio", JSONObject(NativeEngine.statusJson()))
        .put("midi", JSONObject().put("connected", midiName != null).put("name", midiName ?: JSONObject.NULL))
        .put("app", context.packageName)
        .toString()

    @JavascriptInterface
    fun midiSend(csv: String): Boolean {
        val parts = csv.split(',')
        val bytes = ByteArray(parts.size) { parts[it].trim().toInt().toByte() }
        return NativeEngine.midiSend(bytes)
    }

    private fun floats(csv: String): FloatArray =
        if (csv.isEmpty()) FloatArray(0) else csv.split(',').map { it.toFloat() }.toFloatArray()

    /** Live pads: kit (synth = false) or synth with patch/freqs as comma-separated floats. */
    @JavascriptInterface
    fun setLive(mask: Int, fixedVelocity: Int, synth: Boolean, patchCsv: String, freqsCsv: String) =
        NativeEngine.setLive(mask, fixedVelocity, synth, floats(patchCsv), floats(freqsCsv))

    /** Per pad "down bytes;up bytes" (comma-separated), pads joined by "|". */
    @JavascriptInterface
    fun setHitLeds(spec: String) {
        val out = java.io.ByteArrayOutputStream()
        for (pad in spec.split('|').take(16)) {
            val halves = pad.split(';')
            for (h in 0..1) {
                val bytes = halves.getOrNull(h).orEmpty().split(',').filter { it.isNotBlank() }.map { it.trim().toInt() }
                out.write(bytes.size)
                bytes.forEach { out.write(it) }
            }
        }
        NativeEngine.setHitLeds(out.toByteArray())
    }

    @JavascriptInterface
    fun synthNoteOn(pad: Int, velocity: Int, patchCsv: String, freq: Double, heardNs: Double) =
        NativeEngine.synthNoteOn(pad, velocity, floats(patchCsv), freq.toFloat(), heardNs.toLong())

    @JavascriptInterface fun synthNoteOff(pad: Int) = NativeEngine.synthNoteOff(pad)

    @JavascriptInterface
    fun synthPlay(velocity: Int, patchCsv: String, freq: Double, heardNs: Double, holdS: Double) =
        NativeEngine.synthPlay(velocity, floats(patchCsv), freq.toFloat(), heardNs.toLong(), holdS.toFloat())

    @JavascriptInterface
    fun setShaping(threshold: Int, gamma: Double, doubleTriggerMs: Int) =
        NativeEngine.setShaping(threshold, gamma.toFloat(), doubleTriggerMs)

    /** Loads (once) and selects a kit from assets/kits/<id>/; answers with kitLoaded(id, ok). */
    @JavascriptInterface fun loadKit(id: String) = loadKit(id, select = true)

    /** Loads a kit for playKitInstrument without selecting it; answers with kitLoaded(id, ok). */
    @JavascriptInterface fun preloadKit(id: String) = loadKit(id, select = false)

    private fun loadKit(id: String, select: Boolean) {
        loader.execute {
            val ok = try {
                val kit = kits[id] ?: buildKit(id).also { kits[id] = it }
                if (select) NativeEngine.kitSelect(kit)
                true
            } catch (e: Exception) {
                Log.e(MainActivity.TAG, "kit $id", e)
                false
            }
            js("kitLoaded(${JSONObject.quote(id)},$ok)")
        }
    }

    private fun buildKit(id: String): Long {
        val base = "kits/$id/"
        val json = JSONObject(context.assets.open(base + "kit.json").bufferedReader().use { it.readText() })
        val kit = NativeEngine.kitCreate(id)
        val instruments = json.getJSONObject("instruments")
        val index = HashMap<String, Int>()
        for (name in instruments.keys()) {
            val def = instruments.getJSONObject(name)
            val i = NativeEngine.kitAddInstrument(
                kit, name, def.optString("chokeGroup", ""),
                def.optDouble("crossfade", 0.0).toFloat(), def.optBoolean("velocityFilter", false),
            )
            index[name] = i
            val layers = def.getJSONArray("layers")
            for (l in 0 until layers.length()) {
                val layer = layers.getJSONObject(l)
                val samples = layer.getJSONArray("samples")
                val paths = Array(samples.length()) { base + samples.getString(it) }
                check(NativeEngine.kitAddLayer(kit, i, layer.getInt("minVelocity"), layer.getInt("maxVelocity"), paths)) {
                    "layer $l of $name"
                }
            }
        }
        val pads = json.getJSONArray("pads")
        for (p in 0 until minOf(16, pads.length())) NativeEngine.kitSetPad(kit, p, index[pads.getString(p)] ?: -1)
        return kit
    }

    @JavascriptInterface
    fun playInstrument(name: String, velocity: Int, heardNs: Double): Int =
        NativeEngine.playInstrument(name, velocity, heardNs.toLong())

    @JavascriptInterface
    fun playKitInstrument(kitId: String, name: String, velocity: Int, heardNs: Double): Int =
        NativeEngine.playKitInstrument(kitId, name, velocity, heardNs.toLong())

    /** Saves an exported beat to Downloads: the WAV as is, or encoded to AAC (format "m4a"). */
    @JavascriptInterface
    fun saveAudio(name: String, format: String, wavBase64: String): String = try {
        AudioExport.save(context, name, format, Base64.decode(wavBase64, Base64.DEFAULT))
    } catch (e: Exception) {
        Log.e(MainActivity.TAG, "saveAudio $name.$format", e)
        "error: ${e.message}"
    }

    /** Mono float32 PCM, little-endian, base64. */
    @JavascriptInterface
    fun setCue(name: String, base64: String, sampleRate: Int) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val floats = FloatArray(bytes.size / 4)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(floats)
        NativeEngine.setCue(name, floats, sampleRate)
    }

    @JavascriptInterface
    fun playCue(name: String, bus: Int, gain: Double, heardNs: Double): Int =
        NativeEngine.playCue(name, bus, gain.toFloat(), heardNs.toLong())

    @JavascriptInterface fun stopVoice(id: Int) = NativeEngine.stopVoice(id)

    @JavascriptInterface fun stopAll() = NativeEngine.stopAll()

    @JavascriptInterface fun setMasterGain(gain: Double) = NativeEngine.setMasterGain(gain.toFloat())

    @JavascriptInterface fun setBusGain(bus: Int, gain: Double) = NativeEngine.setBusGain(bus, gain.toFloat())
}
