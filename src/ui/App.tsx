import { GameScreen } from './GameScreen';
import { LatencyCalibrationScreen } from './LatencyCalibrationScreen';
import { MainMenu } from './MainMenu';
import { route } from './router';
import { SettingsScreen } from './SettingsScreen';
import { SetupPrompt } from './SetupPrompt';
import { StartScreen } from './StartScreen';
import { StatusBar } from './StatusBar';
import { hasRuntime } from './runtime';

export function App() {
  const r = route.value;
  const started = hasRuntime();
  return (
    <div class="app">
      <StatusBar />
      <main class="content">
        {!started || r.name === 'start' ? (
          <StartScreen />
        ) : r.name === 'setup' ? (
          <SetupPrompt />
        ) : r.name === 'menu' ? (
          <MainMenu />
        ) : r.name === 'settings' ? (
          <SettingsScreen />
        ) : r.name === 'calLatency' ? (
          <LatencyCalibrationScreen back={r.back} />
        ) : (
          <GameScreen id={r.id} key={r.id} />
        )}
      </main>
    </div>
  );
}
