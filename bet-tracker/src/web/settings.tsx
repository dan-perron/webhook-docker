import { appConfig } from '../config.js';
import type { SportCalibration } from '../tracker/calibration.js';
import { Calibration } from './calibration.js';
import { ViewNav } from './page.js';

export function SettingsHeader() {
  return (
    <div class="summary">
      <ViewNav active="settings" />
      <h1 class="page-title">Settings</h1>
    </div>
  );
}

export function SettingsContent({ report }: { report: SportCalibration[] }) {
  return (
    <div>
      <section class="viewing-location">
        <h2>Watching from</h2>
        <p>
          {appConfig.viewingLocation.name} · {appConfig.viewingLocation.zipCode}
        </p>
        <p class="note">
          Game cards show TV and streaming options. NFL OTA availability uses
          your TV market’s game assignment. Streaming subscriptions are listed
          as options; subscription access and antenna reception depend on your
          setup.
        </p>
      </section>
      <p class="note">
        Review how the model’s win estimates compare with settled results.
      </p>
      <Calibration report={report} />
    </div>
  );
}
