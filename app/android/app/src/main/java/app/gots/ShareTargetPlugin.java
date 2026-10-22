package app.gots;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

/**
 * Hands what another app shares into Gots (text, links and images) to the page as a "share"
 * event. Shared images are copied into the cache, since the sender's permission to read them ends
 * with the intent; the page reads the copies through the WebView's file route.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static final int MAX_FILES = 10;
    private static final long MAX_BYTES = 20L * 1024 * 1024;

    @Override
    public void load() {
        // A share that launched the app arrives as the activity's own intent, not a new one.
        handle(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // So an activity that's recreated later doesn't take the same share again.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        ArrayList<Uri> uris = streams(intent, action);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        new Thread(() -> {
            JSObject share = new JSObject();
            share.put("title", subject != null ? subject : "");
            share.put("text", text != null ? text.toString() : "");
            share.put("files", copy(uris));
            // Kept until the page listens, which on a cold start comes after this.
            notifyListeners("share", share, true);
        }).start();
    }

    @SuppressWarnings("deprecation")
    private ArrayList<Uri> streams(Intent intent, String action) {
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            }
            if (uri != null) uris.add(uri);
        } else {
            ArrayList<Uri> list;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            }
            if (list != null) uris.addAll(list);
        }
        return uris;
    }

    private JSArray copy(ArrayList<Uri> uris) {
        JSArray files = new JSArray();
        File folder = new File(getContext().getCacheDir(), "shared");
        // Only the latest share is ever read, so earlier copies can go.
        File[] old = folder.listFiles();
        if (old != null) for (File file : old) file.delete();
        folder.mkdirs();
        for (Uri uri : uris) {
            if (files.length() >= MAX_FILES) break;
            String type = getContext().getContentResolver().getType(uri);
            if (type == null || !type.startsWith("image/")) continue;
            String name = name(uri);
            File target = new File(folder, UUID.randomUUID().toString());
            try (
                InputStream in = getContext().getContentResolver().openInputStream(uri);
                OutputStream out = new FileOutputStream(target)
            ) {
                if (in == null) continue;
                byte[] buffer = new byte[64 * 1024];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_BYTES) throw new IllegalStateException("Too big");
                    out.write(buffer, 0, read);
                }
            } catch (Exception error) {
                Logger.error("ShareTarget", "Couldn't copy a shared file", error);
                target.delete();
                continue;
            }
            JSObject file = new JSObject();
            file.put("path", target.getAbsolutePath());
            file.put("name", name != null ? name : "image");
            file.put("type", type);
            files.put(file);
        }
        return files;
    }

    private String name(Uri uri) {
        if ("file".equals(uri.getScheme())) return uri.getLastPathSegment();
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index != -1) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // The name is only for show.
        }
        return null;
    }
}
