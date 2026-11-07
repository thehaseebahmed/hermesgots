package dev.hermesgots;

import android.widget.Toast;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Shows what the app says in passing in the phone's own toast, at the bottom of the screen, instead
 * of a notice drawn over the WebView: Android's toast keeps its place above a sheet the page has
 * open and reads to assistive tech as the platform's own announcement.
 */
@CapacitorPlugin(name = "Toast")
public class ToastPlugin extends Plugin {

    @PluginMethod
    public void show(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("A toast needs something to say");
            return;
        }
        boolean longer = Boolean.TRUE.equals(call.getBoolean("long", false));
        String said = text.trim();
        getActivity().runOnUiThread(() -> {
            Toast.makeText(getContext(), said, longer ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show();
            call.resolve();
        });
    }
}
