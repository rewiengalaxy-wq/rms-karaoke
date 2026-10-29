package nl.rm.karaoke

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

interface SepListener {
    fun stage(text: String)
    fun progress(k: Int, n: Int)
    fun chunk(k: Int, n: Int, file: String)
    fun done(file: String, duration: Double)
    fun error(msg: String)
}

object Separator {
    @Volatile var cancel = false
    private var env: OrtEnvironment? = null
    private var session: OrtSession? = null
    private val exec = Executors.newSingleThreadExecutor()

    fun start(ctx: Context, input: File, outDir: File, job: String, l: SepListener): Future<*> {
        cancel = false
        return exec.submit {
            try {
                run(ctx, input, outDir, job, l)
            } catch (e: Throwable) {
                l.error(if (e is InterruptedException || e.message == "cancelled") "cancelled" else (e.message ?: e.toString()))
            }
        }
    }

    // ---------- model ----------
    private fun ensureModel(ctx: Context, l: SepListener): OrtSession {
        session?.let { return it }
        val f = File(ctx.filesDir, "mdx_hq4.onnx")
        if (!f.exists() || f.length() < 1000) {
            l.stage("AI-model installeren (eenmalig)…")
            val am = ctx.assets
            val map = JSONObject(am.open("model/map.json").bufferedReader().readText())
            val total = map.getLong("total")
            val regions = map.getJSONArray("regions")
            val skel = am.open("model/graph.bin").readBytes()
            val w16 = am.open("model/w1.bin").readBytes() + am.open("model/w2.bin").readBytes()
            val wb = ByteBuffer.wrap(w16).order(ByteOrder.LITTLE_ENDIAN)
            val tmp = File(ctx.filesDir, "mdx_hq4.tmp")
            BufferedOutputStream(FileOutputStream(tmp), 1 shl 20).use { os ->
                var sp = 0; var op = 0L
                for (i in 0 until regions.length()) {
                    val reg = regions.getJSONArray(i)
                    val start = reg.getLong(0); val len = reg.getInt(1)
                    val gap = (start - op).toInt()
                    os.write(skel, sp, gap); sp += gap; op = start
                    val nf = len / 4
                    val ob = ByteBuffer.allocate(len).order(ByteOrder.LITTLE_ENDIAN)
                    for (j in 0 until nf) ob.putFloat(android.util.Half.toFloat(wb.short))
                    os.write(ob.array()); op += len
                }
                os.write(skel, sp, skel.size - sp)
                if (op + (skel.size - sp) != total) throw IllegalStateException("Model beschadigd")
            }
            tmp.renameTo(f)
        }
        l.stage("AI-model laden…")
        val e = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions()
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        opts.setIntraOpNumThreads(max(1, min(8, Runtime.getRuntime().availableProcessors())))
        val s = e.createSession(f.absolutePath, opts)
        env = e; session = s
        return s
    }

    // ---------- decoding to 44.1 kHz stereo float ----------
    private fun decode(input: File): Pair<FloatArray, FloatArray> {
        val ex = MediaExtractor()
        ex.setDataSource(input.absolutePath)
        var track = -1
        for (i in 0 until ex.trackCount) {
            if (ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) { track = i; break }
        }
        if (track < 0) throw IllegalStateException("Geen audio gevonden in dit bestand")
        ex.selectTrack(track)
        val fmt = ex.getTrackFormat(track)
        val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
        codec.configure(fmt, null, null, 0)
        codec.start()
        var sr = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var chs = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var enc = AudioFormat.ENCODING_PCM_16BIT
        var cap = 1 shl 22
        var data = FloatArray(cap); var n = 0
        val info = MediaCodec.BufferInfo()
        var inDone = false; var outDone = false
        while (!outDone) {
            if (cancel) { codec.release(); ex.release(); throw IllegalStateException("cancelled") }
            if (!inDone) {
                val ii = codec.dequeueInputBuffer(10000)
                if (ii >= 0) {
                    val buf = codec.getInputBuffer(ii)!!
                    val sz = ex.readSampleData(buf, 0)
                    if (sz < 0) { codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true }
                    else { codec.queueInputBuffer(ii, 0, sz, ex.sampleTime, 0); ex.advance() }
                }
            }
            val oi = codec.dequeueOutputBuffer(info, 10000)
            if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val of = codec.outputFormat
                sr = of.getInteger(MediaFormat.KEY_SAMPLE_RATE); chs = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                if (of.containsKey(MediaFormat.KEY_PCM_ENCODING)) enc = of.getInteger(MediaFormat.KEY_PCM_ENCODING)
            } else if (oi >= 0) {
                val ob = codec.getOutputBuffer(oi)!!.order(ByteOrder.LITTLE_ENDIAN)
                ob.position(info.offset); ob.limit(info.offset + info.size)
                val cnt = if (enc == AudioFormat.ENCODING_PCM_FLOAT) info.size / 4 else info.size / 2
                if (n + cnt > cap) { while (n + cnt > cap) cap *= 2; data = data.copyOf(cap) }
                if (enc == AudioFormat.ENCODING_PCM_FLOAT) { for (i in 0 until cnt) data[n++] = ob.float }
                else { for (i in 0 until cnt) data[n++] = ob.short / 32768f }
                codec.releaseOutputBuffer(oi, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
            }
        }
        codec.stop(); codec.release(); ex.release()
        val frames = n / chs
        val l = FloatArray(frames); val r = FloatArray(frames)
        for (i in 0 until frames) {
            l[i] = data[i * chs]
            r[i] = if (chs > 1) data[i * chs + 1] else l[i]
        }
        return if (sr == 44100) Pair(l, r) else Pair(resample(l, sr), resample(r, sr))
    }

    /** windowed-sinc resampler to 44.1 kHz */
    private fun resample(x: FloatArray, sr: Int): FloatArray {
        val ratio = sr.toDouble() / 44100.0
        val outN = floor(x.size / ratio).toInt()
        val fc = min(1.0, 1.0 / ratio) * 0.97
        val half = 16
        val y = FloatArray(outN)
        for (i in 0 until outN) {
            val t = i * ratio; val c = floor(t).toInt()
            var s = 0.0; var ws = 0.0
            for (j in c - half + 1..c + half) {
                if (j < 0 || j >= x.size) continue
                val d = t - j
                val sinc = if (d == 0.0) fc else sin(PI * fc * d) / (PI * d)
                val w = 0.5 + 0.5 * cos(PI * d / half)
                val k = sinc * w; s += x[j] * k; ws += k
            }
            y[i] = if (ws != 0.0) (s / ws).toFloat() else 0f
        }
        return y
    }

    // ---------- main ----------
    private fun run(ctx: Context, input: File, outDir: File, job: String, l: SepListener) {
        val sess = ensureModel(ctx, l)
        if (cancel) throw IllegalStateException("cancelled")
        l.stage("Nummer voorbereiden…")
        val (L, R) = decode(input)
        val n = L.size
        val pad = Dsp.GEN - (n % Dsp.GEN)
        val total = Dsp.TRIM + n + pad + Dsp.TRIM
        val mL = FloatArray(total); val mR = FloatArray(total)
        System.arraycopy(L, 0, mL, Dsp.TRIM, n); System.arraycopy(R, 0, mR, Dsp.TRIM, n)
        val oL = FloatArray(n); val oR = FloatArray(n)
        val chunks = (n + pad) / Dsp.GEN
        val dsp = Dsp()
        val spec = FloatArray(4 * Dsp.DIM_F * Dsp.DIM_T)
        val cL = FloatArray(Dsp.CH); val cR = FloatArray(Dsp.CH)
        val shape = longArrayOf(1, 4, Dsp.DIM_F.toLong(), Dsp.DIM_T.toLong())
        val inName = sess.inputNames.first()
        l.stage("Zang verwijderen…")
        for (k in 0 until chunks) {
            if (cancel) throw IllegalStateException("cancelled")
            val i = k * Dsp.GEN
            dsp.stft(mL, mR, i, spec)
            val y: FloatArray
            OnnxTensor.createTensor(env!!, FloatBuffer.wrap(spec), shape).use { t ->
                sess.run(mapOf(inName to t)).use { res ->
                    val o = res.get(0) as OnnxTensor
                    val fb = o.floatBuffer
                    y = FloatArray(fb.remaining()); fb.get(y)
                }
            }
            dsp.istft(y, cL, cR)
            val len = min(Dsp.GEN, n - i)
            if (len > 0) {
                System.arraycopy(cL, Dsp.TRIM, oL, i, len); System.arraycopy(cR, Dsp.TRIM, oR, i, len)
                val cf = File(outDir, "c_${job}_$k.f32")
                val bb = ByteBuffer.allocate(len * 8).order(ByteOrder.LITTLE_ENDIAN)
                for (j in 0 until len) bb.putFloat(oL[i + j])
                for (j in 0 until len) bb.putFloat(oR[i + j])
                FileOutputStream(cf).use { it.write(bb.array()) }
                l.chunk(k, chunks, cf.name)
            }
            l.progress(k + 1, chunks)
        }
        l.stage("Opslaan…")
        val wav = File(outDir, "inst_$job.wav")
        writeWav(wav, oL, oR)
        input.delete()
        l.done(wav.name, n / 44100.0)
    }

    private fun writeWav(f: File, l: FloatArray, r: FloatArray) {
        val n = l.size
        val hdr = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        hdr.put("RIFF".toByteArray()); hdr.putInt(36 + n * 4); hdr.put("WAVE".toByteArray()); hdr.put("fmt ".toByteArray())
        hdr.putInt(16); hdr.putShort(1); hdr.putShort(2); hdr.putInt(44100); hdr.putInt(44100 * 4); hdr.putShort(4); hdr.putShort(16)
        hdr.put("data".toByteArray()); hdr.putInt(n * 4)
        BufferedOutputStream(FileOutputStream(f), 1 shl 20).use { os ->
            os.write(hdr.array())
            val bb = ByteBuffer.allocate(4 * 8192).order(ByteOrder.LITTLE_ENDIAN)
            var i = 0
            while (i < n) {
                bb.clear()
                val e = min(n, i + 8192)
                for (j in i until e) {
                    bb.putShort((l[j].coerceIn(-1f, 1f) * 32767f).toInt().toShort())
                    bb.putShort((r[j].coerceIn(-1f, 1f) * 32767f).toInt().toShort())
                }
                os.write(bb.array(), 0, bb.position()); i = e
            }
        }
    }
}
