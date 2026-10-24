package app.memento;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Opens a file in the app the platform has for it: the page hands over the bytes and the file's
 * type, they are written to the cache, and a VIEW intent for that type lets Android's own viewer
 * show a photo, its player play a clip or a recording, or whatever app handles the file open it.
 */
@CapacitorPlugin(name = "OpenImage")
public class OpenImagePlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String data = call.getString("dataBase64");
        if (data == null || data.isEmpty()) {
            call.reject("No file");
            return;
        }
        // Widen the intent past images: the page names what it is handing over.
        String type = call.getString("type");
        final String mime = type == null || type.isEmpty() ? "image/*" : type;
        String name = call.getString("name");
        // Only the leaf: the name comes from the page and goes on disk.
        name = name == null ? "" : new File(name).getName();
        if (name.isEmpty()) name = "media";
        String fileName = name;
        new Thread(() -> {
            try {
                File folder = new File(getContext().getCacheDir(), "media");
                // Only the latest open is ever read, so earlier copies can go.
                File[] old = folder.listFiles();
                if (old != null) for (File file : old) file.delete();
                folder.mkdirs();
                File target = new File(folder, fileName);
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                try (FileOutputStream out = new FileOutputStream(target)) {
                    out.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    target
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, mime);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception error) {
                Logger.error("OpenImage", "Couldn't open the file", error);
                call.reject("No app to open it");
            }
        }).start();
    }
}
