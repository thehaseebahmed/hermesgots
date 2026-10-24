package app.memento;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens Android's own notification settings for this app: the master switch, then a row per channel
 * with its own on/off, sound and peek setting. Those are the switches Android keeps, so the app's
 * notification row goes here rather than to a list of its own it could not keep in step.
 */
@CapacitorPlugin(name = "NotificationSettings")
public class NotificationSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String packageName = getContext().getPackageName();
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException noChannels) {
            // An Android without a per-app notification screen still has the app's own page.
            Intent app = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            app.setData(Uri.fromParts("package", packageName, null));
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(app);
                call.resolve();
            } catch (ActivityNotFoundException nowhere) {
                call.reject("No settings screen for the app", nowhere);
            }
        }
    }
}
