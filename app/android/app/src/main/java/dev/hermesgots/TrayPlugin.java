package dev.hermesgots;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/**
 * Hands the page the Mark as read presses the tray queued while it wasn't running
 * ({@link TrayReads}), and clears them: the read marks are the page's, so a press waits here for it.
 * The rows go as they were written; the page's own rule (`src/lib/tray-reads.ts`) reads them.
 */
@CapacitorPlugin(name = "Tray")
public class TrayPlugin extends Plugin {

    @PluginMethod
    public void takeReads(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(TrayReads.PREFS, Context.MODE_PRIVATE);
        String stored;
        synchronized (TrayReads.INSTANCE) {
            stored = prefs.getString(TrayReads.KEY, null);
            prefs.edit().remove(TrayReads.KEY).apply();
        }
        JSArray reads;
        try {
            reads = stored == null ? new JSArray() : new JSArray(stored);
        } catch (JSONException unreadable) {
            // A queue that can't be read is gone either way: the page is handed nothing.
            reads = new JSArray();
        }
        JSObject answer = new JSObject();
        answer.put("reads", reads);
        call.resolve(answer);
    }
}
