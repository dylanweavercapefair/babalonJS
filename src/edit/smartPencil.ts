import type { Editor } from '../core/editor';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';

/** Contextual smart pencil / mouse targeting.
 * Only active when an object is selected and we are in a modeling context
 * (not animation, pose, or sub-tool panels).
 */
export function setupSmartPencil(editor: Editor) {
  const canvas = editor.scene.getEngine().getRenderingCanvas();
  if (!canvas) return;

  let highlight: Mesh | null = null;

  const isModelingContext = () => {
    // Basic context check — expand later as modes are refined
    if (!editor.selected) return false;
    if (editor.photoMode || editor.arMode) return false;
    // Skip if animation or posing UI is active (caller can refine)
    return true;
  };

  const clearHighlight = () => {
    highlight?.dispose();
    highlight = null;
  };

  canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!isModelingContext()) {
      clearHighlight();
      return;
    }
    if (ev.pointerType !== 'pen' && ev.pointerType !== 'mouse') return;

    const pick = editor.scene.pick(editor.scene.pointerX, editor.scene.pointerY);
    if (!pick.hit || !pick.pickedMesh || pick.pickedMesh !== editor.selected?.root) {
      clearHighlight();
      return;
    }

    // Simple surface highlight (small sphere at hit point)
    clearHighlight();
    highlight = Mesh.CreateSphere('smartHighlight', 8, 0.04, editor.scene);
    highlight.position.copyFrom(pick.pickedPoint!);
    highlight.isPickable = false;
    const mat = highlight.material = new (editor.scene.getEngine() as any).StandardMaterial?.('hl', editor.scene) || null;
    if (mat) {
      (mat as any).emissiveColor = new (window as any).BABYLON.Color3(1, 0.8, 0.2);
      (mat as any).disableLighting = true;
    }
  });

  canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (!isModelingContext()) return;
    if (ev.pointerType !== 'pen' && ev.pointerType !== 'mouse') return;
    if (ev.button !== 0) return;

    const pick = editor.scene.pick(editor.scene.pointerX, editor.scene.pointerY);
    if (!pick.hit || !pick.pickedPoint || pick.pickedMesh !== editor.selected?.root) return;

    // Place / select on the actual surface — for now just log the point
    // Later this can insert a vertex or select the nearest existing one
    console.log('Smart pencil surface hit:', pick.pickedPoint);
    // TODO: integrate with face/vertex selection when in mesh-edit mode
  });
}
