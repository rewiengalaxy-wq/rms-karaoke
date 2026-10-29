plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "nl.rm.karaoke"
    compileSdk = 34
    defaultConfig {
        applicationId = "nl.rm.karaoke"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("BUILD_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("BUILD_NUMBER") ?: "1")
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    signingConfigs {
        create("fixed") {
            storeFile = file("rmkaraoke.jks")
            storePassword = "rmkaraoke"
            keyAlias = "rmkaraoke"
            keyPassword = "rmkaraoke"
        }
    }
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fixed")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    androidResources { noCompress += listOf("bin") }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
}
