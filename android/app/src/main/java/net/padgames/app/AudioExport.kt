package net.padgames.app

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Beat maker export: saves a rendered beat (16-bit PCM WAV from the page) to Downloads/Pad Games. */
object AudioExport {
    private const val FOLDER = "Pad Games"
    private const val AAC_BIT_RATE = 192_000
    private const val TIMEOUT_US = 10_000L

    /** Returns where the file went, e.g. "Download/Pad Games/Beat 1.m4a". */
    fun save(context: Context, name: String, format: String, wav: ByteArray): String {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "Beat" }
        return when (format) {
            "wav" -> write(context, "$safe.wav", "audio/wav") { it.write(wav) }
            "m4a" -> {
                val tmp = File.createTempFile("export", ".m4a", context.cacheDir)
                try {
                    encodeAac(parseWav(wav), tmp)
                    write(context, "$safe.m4a", "audio/mp4") { out -> tmp.inputStream().use { it.copyTo(out) } }
                } finally {
                    tmp.delete()
                }
            }
            else -> throw IllegalArgumentException("format $format")
        }
    }

    private fun write(context: Context, fileName: String, mime: String, body: (java.io.OutputStream) -> Unit): String {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("could not create $fileName")
        try {
            resolver.openOutputStream(uri)!!.use(body)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        // MediaStore renames on a clash ("Beat 1 (1).m4a"), so report the name it kept.
        val saved = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: fileName
        return "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER/$saved"
    }

    private class Pcm(val data: ByteBuffer, val sampleRate: Int, val channels: Int)

    /** 16-bit PCM WAV: the fmt and data chunks. */
    private fun parseWav(wav: ByteArray): Pcm {
        val b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        require(wav.size >= 12 && String(wav, 0, 4) == "RIFF" && String(wav, 8, 4) == "WAVE") { "not a WAV" }
        var pos = 12
        var rate = 0
        var channels = 0
        while (pos + 8 <= wav.size) {
            val id = String(wav, pos, 4)
            val size = b.getInt(pos + 4)
            if (id == "fmt ") {
                require(b.getShort(pos + 8).toInt() == 1 && b.getShort(pos + 22).toInt() == 16) { "WAV must be 16-bit PCM" }
                channels = b.getShort(pos + 10).toInt()
                rate = b.getInt(pos + 12)
            } else if (id == "data") {
                require(rate > 0) { "WAV without fmt" }
                val data = ByteBuffer.wrap(wav, pos + 8, minOf(size, wav.size - pos - 8)).slice()
                return Pcm(data, rate, channels)
            }
            pos += 8 + size + (size and 1)
        }
        error("WAV without data")
    }

    private fun encodeAac(pcm: Pcm, out: File) {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, pcm.sampleRate, pcm.channels).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, AAC_BIT_RATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        val muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val frameBytes = 2 * pcm.channels
        val data = pcm.data
        var track = -1
        var muxing = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var framesIn = 0L
            while (true) {
                if (!inputDone) {
                    val i = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (i >= 0) {
                        val buf = codec.getInputBuffer(i)!!
                        val n = minOf(buf.remaining(), data.remaining()) / frameBytes * frameBytes
                        val chunk = data.duplicate().also { it.limit(it.position() + n) }
                        buf.put(chunk)
                        data.position(data.position() + n)
                        val ptsUs = framesIn * 1_000_000L / pcm.sampleRate
                        framesIn += n / frameBytes
                        inputDone = !data.hasRemaining()
                        codec.queueInputBuffer(i, 0, n, ptsUs, if (inputDone) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                    }
                }
                val o = codec.dequeueOutputBuffer(info, TIMEOUT_US)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    muxing = true
                } else if (o >= 0) {
                    val buf = codec.getOutputBuffer(o)!!
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0 && muxing) {
                        buf.position(info.offset).limit(info.offset + info.size)
                        muxer.writeSampleData(track, buf, info)
                    }
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
        } finally {
            codec.release()
            if (muxing) muxer.stop()
            muxer.release()
        }
    }
}
