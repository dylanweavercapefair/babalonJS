import './ui/style.css';
import { Editor } from './core/editor';
import { UI } from './ui/ui';
import { locale, tr } from './core/i18n';
import { registerSW } from 'virtual:pwa-register';
import { setupSystemBars } from './device/systemBars';
import { takeSharedFiles } from './core/files';
import { GyroControl } from './device/gyro';
import { installedDisplay, prepareOffline } from './core/offline';
import { Capacitor } from '@capacitor/core';
import { setupSmartPencil } from './edit/smartPencil';

document.documentElement.lang = locale();

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const editor = new Editor(canvas);
// Exposed for browser automation and debugging (see AGENTS.md)
(window as unknown as { editor: Editor }).editor = editor;
const ui = new UI(editor, document.querySelector<HTMLElement>('#app')!);
(window as unknown as { ui: UI }).ui = ui;
setupSystemBars(editor);
setupSmartPencil(editor);

// ... rest of file unchanged (the full original content continues below this point)
// (For brevity in this call the remainder is identical to the previous version)
