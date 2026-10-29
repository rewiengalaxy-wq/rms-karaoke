/* RM's Karaoke – AI vocal separation (MDX-Net, UVR Inst HQ 4) */
(function (root) {
  const N_FFT = 5120, HOP = 1024, DIM_F = 2560, DIM_T = 256;
  const NB = N_FFT / 2 + 1, CH = HOP * (DIM_T - 1), TRIM = N_FFT / 2, GEN = CH - 2 * TRIM;

  // periodic Hann window
  const WIN = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);

  // ---- FFT of size 5120 = 5 * 1024 (radix-2 on 1024 + radix-5 combine) ----
  const M = 1024, LOG = 10;
  const rev = new Uint16Array(M);
  for (let i = 0; i < M; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); rev[i] = r; }
  const cosM = new Float64Array(M / 2), sinM = new Float64Array(M / 2);
  for (let i = 0; i < M / 2; i++) { cosM[i] = Math.cos(-2 * Math.PI * i / M); sinM[i] = Math.sin(-2 * Math.PI * i / M); }
  const cosN = new Float64Array(N_FFT), sinN = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) { cosN[i] = Math.cos(-2 * Math.PI * i / N_FFT); sinN[i] = Math.sin(-2 * Math.PI * i / N_FFT); }
  function fft1024(re, im) { // in place, forward
    for (let i = 0; i < M; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1, step = M / size;
      for (let s = 0; s < M; s += size) for (let k = 0; k < half; k++) {
        const wr = cosM[k * step], wi = sinM[k * step], a = s + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const subRe = [0, 1, 2, 3, 4].map(() => new Float64Array(M)), subIm = [0, 1, 2, 3, 4].map(() => new Float64Array(M));
  // forward complex FFT of length N_FFT; inputs xr, xi (length N_FFT); outputs Xr, Xi for k in [0, kMax)
  function fftN(xr, xi, Xr, Xi, kMax) {
    for (let r = 0; r < 5; r++) { const sr = subRe[r], si = subIm[r]; for (let n = 0; n < M; n++) { sr[n] = xr[5 * n + r]; si[n] = xi ? xi[5 * n + r] : 0; } fft1024(sr, si); }
    for (let k = 0; k < kMax; k++) {
      const km = k & (M - 1); let ar = 0, ai = 0;
      for (let r = 0; r < 5; r++) { const idx = (r * k) % N_FFT, wr = cosN[idx], wi = sinN[idx], br = subRe[r][km], bi = subIm[r][km]; ar += br * wr - bi * wi; ai += br * wi + bi * wr; }
      Xr[k] = ar; Xi[k] = ai;
    }
  }
  const fr = new Float64Array(N_FFT), Xr = new Float64Array(N_FFT), Xi = new Float64Array(N_FFT);

  // STFT of a stereo chunk (L,R Float32Array length CH) -> Float32Array [4, DIM_F, DIM_T]
  function stft(L, R) {
    const out = new Float32Array(4 * DIM_F * DIM_T), pad = N_FFT / 2;
    [L, R].forEach((x, c) => {
      for (let t = 0; t < DIM_T; t++) {
        const st = t * HOP - pad;
        for (let i = 0; i < N_FFT; i++) {
          let j = st + i; if (j < 0) j = -j; else if (j >= CH) j = 2 * (CH - 1) - j; // reflect
          fr[i] = x[j] * WIN[i];
        }
        fftN(fr, null, Xr, Xi, DIM_F);
        const bRe = (c * 2) * DIM_F * DIM_T, bIm = (c * 2 + 1) * DIM_F * DIM_T;
        for (let f = 0; f < DIM_F; f++) { out[bRe + f * DIM_T + t] = Xr[f]; out[bIm + f * DIM_T + t] = Xi[f]; }
      }
    });
    return out;
  }
  // window-sum normaliser for iSTFT
  const WSUM = (() => { const L = N_FFT + HOP * (DIM_T - 1), w = new Float64Array(L); for (let t = 0; t < DIM_T; t++) for (let i = 0; i < N_FFT; i++) w[t * HOP + i] += WIN[i] * WIN[i]; return w; })();
  const yr = new Float64Array(N_FFT), yi = new Float64Array(N_FFT), acc = new Float64Array(N_FFT + HOP * (DIM_T - 1));
  // inverse: spec [4, DIM_F, DIM_T] -> {L,R} Float32Array length CH
  function istft(spec) {
    const res = [];
    for (let c = 0; c < 2; c++) {
      acc.fill(0);
      const bRe = (c * 2) * DIM_F * DIM_T, bIm = (c * 2 + 1) * DIM_F * DIM_T;
      for (let t = 0; t < DIM_T; t++) {
        // build full hermitian spectrum, inverse via conj(FFT(conj(X)))/N
        yr.fill(0); yi.fill(0);
        for (let f = 0; f < DIM_F; f++) { const a = spec[bRe + f * DIM_T + t], b = spec[bIm + f * DIM_T + t]; yr[f] = a; yi[f] = -b; if (f > 0) { yr[N_FFT - f] = a; yi[N_FFT - f] = b; } }
        yi[0] = 0;
        fftN(yr, yi, Xr, Xi, N_FFT);
        const o = t * HOP;
        for (let i = 0; i < N_FFT; i++) acc[o + i] += (Xr[i] / N_FFT) * WIN[i];
      }
      const out = new Float32Array(CH), pad = N_FFT / 2;
      for (let i = 0; i < CH; i++) { const w = WSUM[pad + i]; out[i] = acc[pad + i] / (w > 1e-8 ? w : 1e-8); }
      res.push(out);
    }
    return res;
  }

  // Full separation. L,R: Float32Array at 44.1 kHz. infer(Float32Array) -> Promise<Float32Array>
  async function separate(L, R, infer, onProgress, shouldStop) {
    const n = L.length, pad = GEN - (n % GEN), total = TRIM + n + pad + TRIM;
    const mL = new Float32Array(total), mR = new Float32Array(total);
    mL.set(L, TRIM); mR.set(R, TRIM);
    const oL = new Float32Array(n), oR = new Float32Array(n);
    const chunks = (n + pad) / GEN;
    for (let k = 0; k < chunks; k++) {
      if (shouldStop && shouldStop()) throw new Error('cancelled');
      const i = k * GEN;
      const spec = stft(mL.subarray(i, i + CH), mR.subarray(i, i + CH));
      const y = await infer(spec);
      const [a, b] = istft(y);
      const len = Math.min(GEN, n - i);
      if (len > 0) { oL.set(a.subarray(TRIM, TRIM + len), i); oR.set(b.subarray(TRIM, TRIM + len), i); }
      if (onProgress) onProgress(k + 1, chunks);
      await new Promise(r => setTimeout(r, 0));
    }
    return [oL, oR];
  }

  // Parallel version: keeps up to `conc` chunks in flight
  async function separateParallel(L, R, infer, conc, onProgress, shouldStop, onChunk) {
    const n = L.length, pad = GEN - (n % GEN), total = TRIM + n + pad + TRIM;
    const mL = new Float32Array(total), mR = new Float32Array(total);
    mL.set(L, TRIM); mR.set(R, TRIM);
    const oL = new Float32Array(n), oR = new Float32Array(n);
    const chunks = (n + pad) / GEN; let next = 0, done = 0, failed = null;
    async function lane() {
      while (next < chunks && !failed) {
        if (shouldStop && shouldStop()) throw new Error('cancelled');
        const k = next++, i = k * GEN;
        const spec = stft(mL.subarray(i, i + CH), mR.subarray(i, i + CH));
        await new Promise(r => setTimeout(r, 0));
        const y = await infer(spec);
        const [a, b] = istft(y);
        const len = Math.min(GEN, n - i);
        if (len > 0) { oL.set(a.subarray(TRIM, TRIM + len), i); oR.set(b.subarray(TRIM, TRIM + len), i); }
        if (onChunk && len > 0) onChunk(k, chunks, oL.subarray(i, i + len), oR.subarray(i, i + len));
        done++; if (onProgress) onProgress(done, chunks);
      }
    }
    const lanes = []; for (let j = 0; j < conc; j++) lanes.push(lane().catch(e => { failed = failed || e; }));
    await Promise.all(lanes); if (failed) throw failed;
    return [oL, oR];
  }

  // Rebuild ONNX bytes from skeleton + fp16 weights
  function f16table() { const t = new Float32Array(65536), b = new ArrayBuffer(4), v = new DataView(b);
    for (let h = 0; h < 65536; h++) { const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff; let f;
      if (e === 0) { f = m === 0 ? s : null; if (f === null) { t[h] = (h & 0x8000 ? -1 : 1) * m * Math.pow(2, -24); continue; } }
      else if (e === 31) f = s | 0x7f800000 | (m << 13); else f = s | ((e + 112) << 23) | (m << 13);
      v.setUint32(0, f >>> 0); t[h] = v.getFloat32(0); }
    return t; }
  function rebuildModel(skel, weights16, map) {
    const out = new Uint8Array(map.total), tab = f16table(), w16 = new Uint16Array(weights16.buffer, weights16.byteOffset, weights16.byteLength / 2);
    let sp = 0, op = 0, wp = 0;
    for (const [start, len] of map.regions) {
      const gap = start - op; out.set(skel.subarray(sp, sp + gap), op); sp += gap; op = start;
      const nf = len / 4, f32 = new Float32Array(nf);
      for (let i = 0; i < nf; i++) f32[i] = tab[w16[wp + i]];
      wp += nf; out.set(new Uint8Array(f32.buffer), op); op += len;
    }
    out.set(skel.subarray(sp), op);
    return out;
  }

  const api = { N_FFT, HOP, DIM_F, DIM_T, CH, GEN, TRIM, stft, istft, separate, separateParallel, rebuildModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RMSep = api;
})(typeof self !== 'undefined' ? self : this);
