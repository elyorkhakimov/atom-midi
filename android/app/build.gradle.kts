import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing key, kept out of git in android/signing/ (see android/README.md).
val signingProps = rootProject.file("signing/keystore.properties").takeIf { it.exists() }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }
}

android {
    namespace = "net.padgames.app"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        // On OnePlus/ColorOS the low-latency (MMAP) audio path is only granted to package names on
        // a system allow list (/system_ext/etc/Multimedia_Daemon_List.xml). android.nativemedia.aaudio
        // is on it and isn't a published app, so builds use it by default. Personal sideloading only;
        // -PappId=net.padgames.app builds under the app's own name (legacy audio path on OnePlus).
        applicationId = (project.findProperty("appId") as String?) ?: "android.nativemedia.aaudio"
        // AMidi (NDK MIDI) needs API 29.
        minSdk = 29
        targetSdk = 36
        versionCode = 9
        versionName = "0.8.1"
        ndk { abiFilters += listOf("arm64-v8a") }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=c++_shared") } }
    }

    signingConfigs {
        if (signingProps != null) create("release") {
            storeFile = rootProject.file(signingProps.getProperty("storeFile"))
            storePassword = signingProps.getProperty("storePassword")
            keyAlias = signingProps.getProperty("keyAlias")
            keyPassword = signingProps.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { prefab = true }

    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt") }
    }

    // The web app build (npm run build in the repo root) is bundled as the WebView content.
    sourceSets["main"].assets.directories += "../../dist"

    // WAVs are already uncompressed PCM; storing them raw lets the native side mmap-read quickly.
    androidResources { noCompress += listOf("wav") }
}

dependencies {
    implementation("com.google.oboe:oboe:1.11.0")
    implementation("androidx.webkit:webkit:1.17.1")
}
