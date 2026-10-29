package nl.rm.karaoke

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private lateinit var outDir: File
    private lateinit var inDir: File
    private val uploads = HashMap<String, OutputStream>()
    private var saveStream: OutputStream? = null
    private var saveUri: Uri? = null
    private var saveFile: File? = null

    private val picker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCb = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        outDir = File(filesDir, "out").apply { mkdirs() }
        inDir = File(cacheDir, "in").apply { mkdirs() }
        outDir.listFiles()?.filter { it.name.startsWith("c_") }?.forEach { it.delete() }

        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        setContentView(web)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/out/", WebViewAssetLoader.InternalStoragePathHandler(this, outDir))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = cb
                picker.launch("audio/*")
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "RMNative")
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__rmBack&&window.__rmBack())?'1':'0'") { r ->
                    if (r?.contains("1") != true) finish()
                }
            }
        })
    }

    private fun js(fn: String, vararg args: Any) {
        val a = args.joinToString(",") { if (it is String) JSONObject.quote(it) else it.toString() }
        web.post { web.evaluateJavascript("window.__rmn&&window.__rmn.$fn($a)", null) }
    }

    private fun keepScreen(on: Boolean) = runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    inner class Bridge {
        @JavascriptInterface fun version(): String = "1"
        @JavascriptInterface fun cores(): Int = Runtime.getRuntime().availableProcessors()

        // --- upload of the song from JS (base64 chunks) ---
        @JavascriptInterface fun fileBegin(job: String) {
            uploads[job]?.close()
            uploads[job] = FileOutputStream(File(inDir, "$job.audio"))
        }
        @JavascriptInterface fun fileChunk(job: String, b64: String) {
            uploads[job]?.write(Base64.decode(b64, Base64.DEFAULT))
        }
        @JavascriptInterface fun fileEnd(job: String) { uploads.remove(job)?.close() }

        // --- AI separation ---
        @JavascriptInterface fun separate(job: String): Boolean {
            val f = File(inDir, "$job.audio")
            if (!f.exists()) return false
            keepScreen(true)
            Separator.start(this@MainActivity, f, outDir, job, object : SepListener {
                override fun stage(text: String) = js("stage", text)
                override fun progress(k: Int, n: Int) = js("progress", k, n)
                override fun chunk(k: Int, n: Int, file: String) = js("chunk", k, n, "https://appassets.androidplatform.net/out/$file")
                override fun done(file: String, duration: Double) { keepScreen(false); js("done", "https://appassets.androidplatform.net/out/$file", duration) }
                override fun error(msg: String) { keepScreen(false); f.delete(); js("error", msg) }
            })
            return true
        }
        @JavascriptInterface fun cancel() { Separator.cancel = true }
        @JavascriptInterface fun deleteOut(name: String) {
            if (!name.contains("/")) File(outDir, name).delete()
        }

        // --- saving a file to Downloads ---
        @JavascriptInterface fun saveBegin(name: String, mime: String): Boolean {
            return try {
                if (Build.VERSION.SDK_INT >= 29) {
                    val cv = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/RM Karaoke")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)!!
                    saveUri = uri; saveStream = contentResolver.openOutputStream(uri)
                } else {
                    val d = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "RM Karaoke").apply { mkdirs() }
                    val f = File(d, name); saveFile = f; saveStream = FileOutputStream(f)
                }
                true
            } catch (e: Exception) { false }
        }
        @JavascriptInterface fun saveChunk(b64: String) { saveStream?.write(Base64.decode(b64, Base64.DEFAULT)) }
        @JavascriptInterface fun saveEnd(): Boolean {
            return try { saveStream?.close(); saveStream = null; true } catch (e: Exception) { false }
        }
    }
}
