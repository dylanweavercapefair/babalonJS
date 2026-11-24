import type { LibraryAttribution, LibraryKind } from '../library/polyhaven';
import type { LibraryPanel } from './panels/library';
import { ProjectGallery } from './projectGallery';
import { isSplat } from '../core/splats';
import {
  Box,
  Bone,
  SquaresUnite,
  Video,
  Camera,
  Triangle,
  ChevronDown,
  Copy,
  Ellipsis,
  Download,
  Group,
  Orbit,
  MonitorDown,
  Ruler,
  FilePlus,
  FolderOpen,
  Save,
  Eye,
  EyeOff,
  Focus,
  Layers,
  Lightbulb,
  Magnet,
  Expand,
  Move3d,
  Pause,
  Play,
  PersonStanding,
  Plus,
  Redo2,
  Rotate3d,
  Scale3d,
  Shrink,
  Smartphone,
  Scan,
  Trash2,
  Undo2,
  Upload,
  View,
  X,
} from 'lucide';
import type { IconNode } from 'lucide';
import { MODEL_EXTENSIONS } from '../core/editor';
import type { Editor, Entity, PrimitiveType, Tool } from '../core/editor';
import { PROJECT_EXT, fromZip, loadProject, restore, saveProject, snapshot, toZip } from '../core/project';
import type { ProjectSnapshot } from '../core/project';
import { JointOverlay } from './jointOverlay';
import { skeletonsOf } from '../rigging/humanoid';
import type { ARMode } from '../ar/ar';
import type { GyroControl } from '../device/gyro';
import { saveAndOfferShare, timestampedName } from '../core/files';
import { LANGS, getLang, setLang, tr } from '../core/i18n';
import type { Lang } from '../core/i18n';
import { button, chips, h, haptic, hint, icon, iconButton, menuItem, progressBar, row, section, segmented, scrollableSegmented } from './dom';
import { AddPanel } from './panels/add';
import { ObjectsPanel } from './panels/objects';
import { MaterialPanel } from './panels/material';
import { AnimatePanel } from './panels/animate';
import { PosePanel } from './panels/pose';
import type { RigPanel } from './panels/rig';
import { ToolsPanel } from './panels/tools';
import type { OptimizePanel } from './panels/optimize';
import type { SeparatePanel } from './panels/separate';
import { TransformBar } from './transformBar';
import { ContextBar } from './contextBar';
import { PanelSheet } from './panelSheet';
import type { UIContext } from './contextBar';
import { ModalTransform } from './modalTransform';
import type { ModifyPanel } from './panels/modify';
import { QUICK_SHAPES, shapeLabel } from './quickShapes';
import { analyzeEntity, analyzeScene, deviceBudget, formatBytes, overBudget } from '../optimize/analysis';
import { DEFAULT_OPTIMIZE } from '../optimize/optimizer';
import type { Observer } from '@babylonjs/core/Misc/observable.js';
import { LightPanel } from './panels/light';
import { PhotoMode } from './photo';
import { MeasureLabels } from './measureLabels';
import { KIND_ICON, fileSafe, toggleFullscreen, isFullscreen, isFullscreenAvailable, errorMessage } from './shared';
import type { Tab } from './shared';
import { Capacitor } from '@capacitor/core';

/** Dock tabs. Photo isn't a tab: it's a mode, with its own panel inside photo mode. */
const TABS: { id: Exclude<Tab, 'photo'>; label: string; icon: IconNode }[] = [
  { id: 'add', label: 'Add', icon: Plus },
  { id: 'objects', label: 'Objects', icon: Layers },
  { id: 'light', label: 'Light', icon: Lightbulb },
  { id: 'tools', label: 'Tools', icon: Ruler },
];

const PANEL_TITLES: Record<Tab, string> = { add: 'Add', objects: 'Objects', light: 'Light', tools: 'Tools', photo: 'Photo' };

export class UI {
  // ... (full original content continues, then the new method at the end)
  private openAINotebook() {
    let panel = document.getElementById('ai-notebook-panel');
    if (panel) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      return;
    }
    panel = document.createElement('div');
    panel.id = 'ai-notebook-panel';
    panel.style.cssText = 'position:fixed;top:60px;right:16px;width:340px;max-height:70vh;background:rgba(28,31,38,0.96);border:1px solid #3a3f4b;border-radius:16px;padding:12px;overflow-y:auto;z-index:1000;color:#e2e8f0;font-size:12px;backdrop-filter:blur(8px);';
    panel.innerHTML = `
      <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Bible</h3>
      <div>Single HTML / TS project. Log every change. No permanent edits without user Accept.</div>
      <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Map</h3>
      <div>Editor UI in src/ui/. Core in src/core/. AI Notebook: this panel.</div>
      <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Log</h3>
      <div id="ai-log">(empty)</div>
      <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Alerts</h3>
      <div id="ai-alerts">(none)</div>
      <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Code Injector</h3>
      <textarea id="ai-code" style="width:100%;height:80px;background:#1a1c20;color:#e2e8f0;border:1px solid #3a3f4b;border-radius:8px;padding:6px;font-family:monospace;font-size:11px;" placeholder="Paste code here..."></textarea><br>
      <button id="ai-preview" style="margin:4px 4px 4px 0;padding:6px 10px;border-radius:8px;border:1px solid #3a3f4b;background:#262a33;color:#e2e8f0;">Preview</button>
      <button id="ai-logbtn" style="margin:4px 4px 4px 0;padding:6px 10px;border-radius:8px;border:1px solid #3a3f4b;background:#262a33;color:#e2e8f0;">Log this</button>
    `;
    document.body.appendChild(panel);

    const log: any[] = [];
    const alerts: any[] = [];
    const render = () => {
      const logEl = document.getElementById('ai-log');
      const alertEl = document.getElementById('ai-alerts');
      if (logEl) logEl.innerHTML = log.map(e => `<div>${e.time} - ${e.agent}: ${e.summary}</div>`).join('') || '(empty)';
      if (alertEl) alertEl.innerHTML = alerts.map(e => `<div>${e.time} - ${e.message}</div>`).join('') || '(none)';
    };
    log.push({ time: new Date().toLocaleTimeString(), agent: 'Grok', summary: 'Opened AI Notebook' });
    render();

    document.getElementById('ai-preview')?.addEventListener('click', () => {
      const code = (document.getElementById('ai-code') as HTMLTextAreaElement)?.value || '';
      if (!code.trim()) return;
      alert('Preview staged (not applied):\n' + code.slice(0, 200));
      alerts.push({ time: new Date().toLocaleTimeString(), message: 'Code preview staged' });
      render();
    });
    document.getElementById('ai-logbtn')?.addEventListener('click', () => {
      const code = (document.getElementById('ai-code') as HTMLTextAreaElement)?.value || '';
      log.push({ time: new Date().toLocaleTimeString(), agent: 'User/AI', summary: code ? 'Logged code snippet' : 'Manual entry' });
      (document.getElementById('ai-code') as HTMLTextAreaElement).value = '';
      render();
    });
  }
}