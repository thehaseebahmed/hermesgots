package dev.hermesgots;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(OpenImagePlugin.class);
        registerPlugin(NotificationSettingsPlugin.class);
        registerPlugin(BubblePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
