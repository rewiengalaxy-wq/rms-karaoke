package nl.rm.karaoke

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** STFT / iSTFT exactly matching the MDX-Net (UVR) pre-processing. Not thread-safe: one instance per thread. */
class Dsp {
    companion object {
        const val N_FFT = 5120
        const val HOP = 1024
        const val DIM_F = 2560
        const val DIM_T = 256
        const val CH = HOP * (DIM_T - 1)
        const val TRIM = N_FFT / 2
        const val GEN = CH - 2 * TRIM
        private const val M = 1024
        private const val LOG = 10
    }

    private val win = FloatArray(N_FFT) { (0.5 - 0.5 * cos(2 * PI * it / N_FFT)).toFloat() }
    private val rev = IntArray(M).also { r ->
        for (i in 0 until M) { var x = 0; for (b in 0 until LOG) x = x or (((i shr b) and 1) shl (LOG - 1 - b)); r[i] = x }
    }
    private val cosM = DoubleArray(M / 2) { cos(-2 * PI * it / M) }
    private val sinM = DoubleArray(M / 2) { sin(-2 * PI * it / M) }
    private val cosN = DoubleArray(N_FFT) { cos(-2 * PI * it / N_FFT) }
    private val sinN = DoubleArray(N_FFT) { sin(-2 * PI * it / N_FFT) }
    private val subRe = Array(5) { DoubleArray(M) }
    private val subIm = Array(5) { DoubleArray(M) }
    private val fr = DoubleArray(N_FFT)
    private val xr = DoubleArray(N_FFT)
    private val xi = DoubleArray(N_FFT)
    private val yr = DoubleArray(N_FFT)
    private val yi = DoubleArray(N_FFT)
    private val acc = DoubleArray(N_FFT + HOP * (DIM_T - 1))
    private val wsum = DoubleArray(N_FFT + HOP * (DIM_T - 1)).also { w ->
        for (t in 0 until DIM_T) for (i in 0 until N_FFT) w[t * HOP + i] += (win[i] * win[i]).toDouble()
    }

    private fun fft1024(re: DoubleArray, im: DoubleArray) {
        for (i in 0 until M) {
            val j = rev[i]
            if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
        }
        var size = 2
        while (size <= M) {
            val half = size shr 1; val step = M / size
            var s = 0
            while (s < M) {
                for (k in 0 until half) {
                    val wr = cosM[k * step]; val wi = sinM[k * step]; val a = s + k; val b = a + half
                    val tr = re[b] * wr - im[b] * wi; val ti = re[b] * wi + im[b] * wr
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
                }
                s += size
            }
            size = size shl 1
        }
    }

    /** forward complex FFT of length N_FFT; outputs bins [0, kMax) into xr/xi */
    private fun fftN(inR: DoubleArray, inI: DoubleArray?, kMax: Int) {
        for (r in 0 until 5) {
            val sr = subRe[r]; val si = subIm[r]
            for (n in 0 until M) { sr[n] = inR[5 * n + r]; si[n] = inI?.get(5 * n + r) ?: 0.0 }
            fft1024(sr, si)
        }
        for (k in 0 until kMax) {
            val km = k and (M - 1); var ar = 0.0; var ai = 0.0
            for (r in 0 until 5) {
                val idx = (r * k) % N_FFT; val wr = cosN[idx]; val wi = sinN[idx]
                val br = subRe[r][km]; val bi = subIm[r][km]
                ar += br * wr - bi * wi; ai += br * wi + bi * wr
            }
            xr[k] = ar; xi[k] = ai
        }
    }

    /** chunk of CH samples per channel starting at [off] -> spec [4, DIM_F, DIM_T] */
    fun stft(l: FloatArray, r: FloatArray, off: Int, out: FloatArray) {
        val pad = N_FFT / 2
        for (c in 0 until 2) {
            val x = if (c == 0) l else r
            val bRe = (c * 2) * DIM_F * DIM_T; val bIm = (c * 2 + 1) * DIM_F * DIM_T
            for (t in 0 until DIM_T) {
                val st = t * HOP - pad
                for (i in 0 until N_FFT) {
                    var j = st + i
                    if (j < 0) j = -j else if (j >= CH) j = 2 * (CH - 1) - j
                    fr[i] = (x[off + j] * win[i]).toDouble()
                }
                fftN(fr, null, DIM_F)
                for (f in 0 until DIM_F) { out[bRe + f * DIM_T + t] = xr[f].toFloat(); out[bIm + f * DIM_T + t] = xi[f].toFloat() }
            }
        }
    }

    /** spec [4, DIM_F, DIM_T] -> two channels of CH samples */
    fun istft(spec: FloatArray, outL: FloatArray, outR: FloatArray) {
        val pad = N_FFT / 2
        for (c in 0 until 2) {
            java.util.Arrays.fill(acc, 0.0)
            val bRe = (c * 2) * DIM_F * DIM_T; val bIm = (c * 2 + 1) * DIM_F * DIM_T
            for (t in 0 until DIM_T) {
                java.util.Arrays.fill(yr, 0.0); java.util.Arrays.fill(yi, 0.0)
                for (f in 0 until DIM_F) {
                    val a = spec[bRe + f * DIM_T + t].toDouble(); val b = spec[bIm + f * DIM_T + t].toDouble()
                    yr[f] = a; yi[f] = -b
                    if (f > 0) { yr[N_FFT - f] = a; yi[N_FFT - f] = b }
                }
                yi[0] = 0.0
                fftN(yr, yi, N_FFT)
                val o = t * HOP
                for (i in 0 until N_FFT) acc[o + i] += (xr[i] / N_FFT) * win[i]
            }
            val out = if (c == 0) outL else outR
            for (i in 0 until CH) { val w = wsum[pad + i]; out[i] = (acc[pad + i] / (if (w > 1e-8) w else 1e-8)).toFloat() }
        }
    }
}
