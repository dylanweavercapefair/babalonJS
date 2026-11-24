import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Observer } from '@babylonjs/core/Misc/observable.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Editor } from '../core/editor';
import type { FaceSelection } from './selection';
import { Deform, DeformSpace, recordDeform } from './deform';
import { editBlocker } from './combine';
import { tr } from '../core/i18n';
import { topologyWeights } from './faceTopology';

/**
 * Moves, turns or scales only the selected faces with the gizmo (soft selection fades the change
 * over connected surface distance). Each frame only touches the vertices that move.
 */
export class SelectionTransform {
  readonly handle: Mesh;
  softRadius = 0;
  private observer: Observer<Scene>;
  private sessions: { deform: Deform; space: DeformSpace; base: Float32Array; vertices: Uint32Array; weights: Float32Array; world: Matrix; inverse: Matrix }[] | null = null;
  private center = Vector3.Zero();
  private signature = '';
  readonly editor: Editor;
  readonly selection: FaceSelection;
  constructor(editor: Editor, selection: FaceSelection) {
    this.editor = editor; this.selection = selection;
    const reason = editBlocker(selection.entity); if (reason) throw new Error(reason);
    this.handle = new Mesh('Selection transform', editor.scene);
    this.handle.isPickable = false; this.handle.rotationQuaternion = Quaternion.Identity();
    this.recenter();
    this.observer = editor.scene.onBeforeRenderObservable.add(() => {
      if (!this.sessions) return;
      const key = this.handle.position.asArray().join() + this.handle.scaling.asArray().join() + this.handle.rotationQuaternion!.asArray().join();
      if (key !== this.signature) { this.signature = key; this.update(); }
    });
  }
  recenter() {
    const bounds = this.selection.bounds();
    if (!bounds) throw new Error(tr('Select faces first.'));
    this.center.copyFrom(bounds.center);
    this.handle.position.copyFrom(this.center); this.handle.scaling.setAll(1); this.handle.rotationQuaternion!.copyFrom(Quaternion.Identity());
  }
  /** Start of a gizmo drag: which vertices move and by how much (soft selection). */
  begin() {
    if (this.sessions) return;
    this.sessions = [];
    for (const [mesh, faces] of this.selection.faces) {
      if (!faces.size) continue;
      const topology = this.selection.neighbors(mesh), deform = new Deform(mesh, topology);
      const space = new DeformSpace(deform, false), base = mesh.skeleton ? space.positions.slice() : deform.base;
      const { weld } = topology, indices = mesh.getIndices()!;
      const seeds = new Set<number>();
      const m = faces.mask;
      for (let f = 0; f < m.length; f++) if (m[f]) for (let j = 0; j < 3; j++) seeds.add(weld[indices[f * 3 + j]]);
      const world = mesh.computeWorldMatrix(true).clone();
      const scale = Math.cbrt(Math.abs(world.determinant())) || 1;
      const falloff = topologyWeights(topology, indices, base, seeds, this.softRadius, scale);
      // Moving vertices and their weights (smoothstep falloff)
      const vertices: number[] = [], weights: number[] = [];
      for (let i = 0; i < weld.length; i++) {
        if (falloff[i] <= 0) continue;
        vertices.push(i); weights.push(falloff[i]);
      }
      this.sessions.push({ deform, space, base, vertices: Uint32Array.from(vertices), weights: Float32Array.from(weights), world, inverse: world.clone().invert() });
    }
    // The meshes' buffers were replaced by updatable ones: the highlight follows them
    this.selection.refresh();
  }
  /** One frame of the drag: only the moving vertices, only the changed GPU range. */
  update() {
    if (!this.sessions) return;
    const transform = Matrix.Translation(-this.center.x, -this.center.y, -this.center.z).multiply(Matrix.Compose(this.handle.scaling, this.handle.rotationQuaternion!, this.handle.position));
    const v = new Vector3();
    for (const { deform, space, base, vertices, weights, world, inverse } of this.sessions) {
      const full = world.multiply(transform).multiply(inverse);
      const b = base;
      for (let k = 0; k < vertices.length; k++) {
        const i = vertices[k], o = i * 3, w = weights[k];
        Vector3.TransformCoordinatesFromFloatsToRef(b[o], b[o + 1], b[o + 2], full, v);
        space.setPosition(i, b[o] + (v.x - b[o]) * w, b[o + 1] + (v.y - b[o + 1]) * w, b[o + 2] + (v.z - b[o + 2]) * w);
        deform.touch(i);
      }
      deform.updateNormals(vertices);
      deform.upload();
    }
    this.editor.invalidate();
  }
  end(cancel = false) {
    const sessions = this.sessions;
    if (!sessions) return;
    if (!cancel) this.update();
    this.sessions = null;
    const before = sessions.map((s) => ({ mesh: s.deform.mesh, state: s.deform.startState() }));
    if (cancel) {
      before.forEach(({ mesh, state }) => Deform.restore(mesh, state));
      this.selection.refresh(); this.editor.invalidate();
      return;
    }
    sessions.forEach((s) => s.deform.finish());
    const after = sessions.map((s) => ({ mesh: s.deform.mesh, state: s.deform.state() }));
    if (!after.some((a, i) => positionsDiffer(a.state.positions, before[i].state.positions))) { this.recenter(); return; }
    // Saved like any edited geometry; one undo step for the whole drag
    recordDeform(this.editor, this.selection.entity, after.map((a, i) => ({ mesh: a.mesh, before: before[i].state, after: a.state })), () => this.selection.refresh());
    this.recenter();
  }
  dispose() { this.end(true); this.editor.scene.onBeforeRenderObservable.remove(this.observer); this.handle.dispose(); }
}

function positionsDiffer(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return true;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return true;
  return false;
}
