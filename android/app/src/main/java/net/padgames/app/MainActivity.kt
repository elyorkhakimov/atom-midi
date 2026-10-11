package net.padgames.app

import android.annotation.SuppressLint
import android.app.Activity
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Hosts the web app (bundled from dist/) in a WebView. The ATOM is opened natively and its
 * messages reach the page through PadBridge's Web MIDI stand-in; sound comes from the
 * native engine instead of Web Audio.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var bridge: PadBridge
    private lateinit var midiManager: MidiManager
    private val main = Handler(Looper.getMainLooper())
    private var atomInfo: MidiDeviceInfo? = null
    private var atomDevice: MidiDevice? = null
    private var started = false

    private val deviceCallback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(info: MidiDeviceInfo) {
            if (atomDevice == null && started && isAtom(info)) openAtom(info)
        }

        override fun onDeviceRemoved(info: MidiDeviceInfo) {
            if (info.id == atomInfo?.id) closeAtom(sendExit = false)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }
        bridge = PadBridge(this, webView)
        webView.addJavascriptInterface(bridge, "PadNative")
        setContentView(webView)
        hideSystemBars()

        NativeEngine.midiListener = { data, ts -> bridge.forwardMidi(data, ts) }
        midiManager = getSystemService(MidiManager::class.java)
        @Suppress("DEPRECATION")
        midiManager.registerDeviceCallback(deviceCallback, main)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/index.html")
    }

    override fun onStart() {
        super.onStart()
        started = true
        if (!NativeEngine.start(assets)) Log.e(TAG, "audio engine failed to start")
        webView.onResume()
        findAtom()?.let { openAtom(it) }
    }

    override fun onStop() {
        // Background: hand the ATOM back to factory mode and release the exclusive audio stream.
        started = false
        closeAtom(sendExit = true)
        webView.onPause()
        NativeEngine.stop()
        super.onStop()
    }

    override fun onDestroy() {
        midiManager.unregisterDeviceCallback(deviceCallback)
        NativeEngine.midiListener = null
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // -------------------------------------------------------------------------
    // ATOM
    // -------------------------------------------------------------------------
    private fun deviceName(info: MidiDeviceInfo): String =
        info.properties.getString(MidiDeviceInfo.PROPERTY_NAME)
            ?: info.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT)
            ?: ""

    /** Same rule as isAtomPortName() in atomMap.ts. */
    private fun isAtom(info: MidiDeviceInfo): Boolean {
        val name = deviceName(info)
        return info.outputPortCount > 0 && info.inputPortCount > 0 &&
            Regex("\\batom\\b", RegexOption.IGNORE_CASE).containsMatchIn(name) &&
            !Regex("\\bsq\\b", RegexOption.IGNORE_CASE).containsMatchIn(name)
    }

    private fun findAtom(): MidiDeviceInfo? =
        midiManager.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM).firstOrNull { isAtom(it) }

    private fun openAtom(info: MidiDeviceInfo) {
        atomInfo = info
        midiManager.openDevice(info, { device ->
            if (device == null || !started || atomInfo?.id != info.id) {
                device?.close()
                return@openDevice
            }
            if (NativeEngine.midiOpen(device)) {
                atomDevice = device
                bridge.midiState(true, deviceName(info))
            } else {
                Log.e(TAG, "could not open ATOM ports")
                device.close()
            }
        }, main)
    }

    private fun closeAtom(sendExit: Boolean) {
        val device = atomDevice ?: run { atomInfo = null; return }
        // Native-mode exit (Note Off ch16 note 0), like AtomDriver on pagehide.
        if (sendExit) NativeEngine.midiSend(byteArrayOf(0x8F.toByte(), 0, 0))
        NativeEngine.midiClose()
        device.close()
        atomDevice = null
        atomInfo = null
        bridge.midiState(false, null)
    }

    companion object {
        const val TAG = "PadGames"
    }
}
