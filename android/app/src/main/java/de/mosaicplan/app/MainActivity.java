package de.mosaicplan.app;

import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * MosaicPlan-Aktivität. Zusätzlich zu Capacitors BridgeActivity:
 *
 * Absturz der Anzeige (WebView-Renderer): Ohne Behandlung beendet Android die ganze App, wenn der
 * Renderer-Prozess abstürzt oder wegen Speichermangels beendet wird (z. B. bei einem sehr großen PDF).
 * Stattdessen wird die Aktivität neu aufgebaut – mit einer neuen WebView, denn die alte darf laut
 * Android-Dokumentation nicht weiter benutzt werden. Die Projekte liegen in IndexedDB und bleiben
 * erhalten. Die neu geladene Seite bekommt das Ereignis „mp-renderer-recovered“ und zeigt einen Hinweis.
 * Stürzt die Anzeige kurz nach einem Neustart erneut ab, wird nicht endlos neu gestartet, sondern die
 * Aktivität geschlossen.
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "MosaicPlan";
    /** Zwei Abstürze innerhalb dieser Zeit gelten als Schleife */
    private static final long LOOP_WINDOW_MS = 20_000;

    /** über den Neuaufbau der Aktivität hinweg (gleicher App-Prozess) */
    private static volatile boolean recoveryNoticePending = false;
    private static volatile long lastRecoveryAt = 0;

    private boolean recovering = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge == null) {
            return; // keine WebView installiert: Capacitor zeigt bereits seinen Hinweis
        }
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    return handleRenderProcessGone(view, detail);
                }

                @Override
                public void onPageLoaded(WebView webView) {
                    if (!recoveryNoticePending) {
                        return;
                    }
                    recoveryNoticePending = false;
                    webView.evaluateJavascript(
                        "window.__mpRendererRecovered=true;window.dispatchEvent(new Event('mp-renderer-recovered'));",
                        null
                    );
                }
            }
        );
    }

    private boolean handleRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null && detail.didCrash();
        Log.w(TAG, "WebView-Renderer beendet (" + (crashed ? "Absturz" : "vom System beendet") + ")");
        if (recovering) {
            return true;
        }
        recovering = true;

        // Die tote WebView sofort aus der Ansicht nehmen; sie darf nicht mehr benutzt werden.
        ViewParent parent = view.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).removeView(view);
        }

        long now = SystemClock.elapsedRealtime();
        boolean loop = lastRecoveryAt != 0 && now - lastRecoveryAt < LOOP_WINDOW_MS;
        lastRecoveryAt = now;
        if (loop) {
            Log.e(TAG, "Anzeige erneut kurz nach einem Neustart abgestürzt – App wird geschlossen statt neu gestartet");
            new Handler(Looper.getMainLooper()).post(this::finish);
            return true;
        }
        recoveryNoticePending = true;
        new Handler(Looper.getMainLooper()).post(this::recreate);
        // true: wir haben den Ausfall behandelt, Android beendet die App nicht
        return true;
    }
}
