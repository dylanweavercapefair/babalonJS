import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Viewport } from '@babylonjs/core/Maths/math.viewport.js';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents.js';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { tr } from '../core/i18n';
import type { Editor, Entity } from '../core/editor';
import { Deform, recordDeform } from './deform';
import { buildTopology, type FaceSelection } from './selection';
import { computeTopology, topologyWeights } from './faceTopology';
import type { FaceTopology } from './faceTopology';
import { applyPart, capturePart } from './parts';
import type { MeshPart } from './parts';
import { catmullClark, edgeKey, mirrorVertexX } from './subdivisionMath';
import type { CageMeshData, PolyFace } from './subdivisionMath';
import type { Separator } from './separate';

const MAX_CONTROL_POINTS = 512;
const MAX_CONTROL_FACES = 2048;
const SUBDIVISION_LEVEL = 2;

interface SubDOutput {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  materials: { material: number; start: number; count: number }[];
}

interface CageRecord {
  source: Mesh;
  smooth: Mesh;
  wire: ReturnType<typeof CreateLineSystem>;
  topology: FaceTopology;
  controlPositions: Float32Array;
  representative: Int32Array;
  handles: Mesh[];
  originalVisibility: number;
  originalPickable: boolean;
  edgeCount: number;
  handleSize: number;
  faceCache: FaceCache | null;
  projected: Float32Array;
}

interface FacePatch {
  faces: number[];
  vertices: number[];
}

interface CageEdge {
  a: number;
  b: number;
}

interface FaceCache {
  patches: FacePatch[];
  patchByFace: Int32Array;
  edges: CageEdge[];
}

interface CageContext {
  kind: 'vertex' | 'edge' | 'face';
  record: CageRecord;
  vertices: number[];
  anchor: number;
  faces: number[];
  point: Vector3;
}

interface ContextDrag {
  pointerId: number;
  point: Vector3;
  normal: Vector3;
  last: Vector3;
}

interface DragTarget {
  record: CageRecord;
  deform: Deform;
  before: ReturnType<Deform['startState']>;
  primaryWeights: Float32Array;
  mirrorWeights: Float32Array;
  vertices: Uint32Array;
  sides: Int8Array;
  sourceInverse: Matrix;
}

interface DragSession {
  targets: DragTarget[];
  rootWorld: Matrix;
  rootInverse: Matrix;
  symmetry: boolean;
  centerSeed: boolean;
  delta: Vector3;
}

interface ExtrusionItem {
  mesh: Mesh;
  before: MeshPart;
  faces: Set<number>;
}

export class SubDCage {
  readonly editor: Editor;
  readonly separator: Separator;
  readonly selection: FaceSelection;
  readonly entity: Entity;
  readonly records: CageRecord[] = [];
  readonly wireMaterial: StandardMaterial;
  readonly handleMaterial: StandardMaterial;
  readonly hoverMaterial: StandardMaterial;
  softRadius = 0;
  symmetry = false;
  extrudeDistance = 0;
  private readonly selectedPoints = new Map<CageRecord, Set<number>>();
  private drag: DragSession | null = null;
  private hoverContext: CageContext | null = null;
  private contextDrag: ContextDrag | null = null;
  private hoverSurface: Mesh | null = null;
  private hoverEdge: ReturnType<typeof CreateLineSystem> | null = null;
  private removePointerObserver: (() => void) | null = null;
  private removePointerLeave: (() => void) | null = null;
  private readonly viewport = new Viewport(0, 0, 1, 1);
  private readonly projected = new Vector3();
  private extrusion: ExtrusionItem[] | null = null;

  constructor(editor: Editor, separator: Separator, selection: FaceSelection) {
    this.editor = editor;
    this.separator = separator;
    this.selection = selection;
    this.entity = selection.entity;
    const meshes = this.entity.meshes;
    let controlCount = 0, faceCount = 0;
    for (const abstract of meshes) {
      if (!(abstract instanceof Mesh) || !abstract.getIndices() || !abstract.getVerticesData('position')) {
        throw new Error(tr('SubD Cage needs triangle meshes.'));
      }
      if (abstract.skeleton || abstract.morphTargetManager?.numTargets) {
        throw new Error(tr('SubD Cage does not support rigged or morphed meshes.'));
      }
      const topology = buildTopology(abstract);
      controlCount += topology.vertexStart.length - 1;
      faceCount += abstract.getTotalIndices() / 3;
    }
    if (controlCount > MAX_CONTROL_POINTS || faceCount > MAX_CONTROL_FACES) {
      throw new Error(tr('SubD Cage needs a low-poly mesh with at most {n} control points.', { n: MAX_CONTROL_POINTS }));
    }
    this.wireMaterial = new StandardMaterial('SubD cage wire', editor.scene);
    this.wireMaterial.disableLighting = true;
    this.wireMaterial.emissiveColor = Color3.FromHexString('#a57abb');
    this.wireMaterial.diffuseColor = this.wireMaterial.emissiveColor;
    this.wireMaterial.alpha = 0.38;
    this.handleMaterial = new StandardMaterial('SubD cage handles', editor.scene);
    this.handleMaterial.disableLighting = true;
    this.handleMaterial.emissiveColor = Color3.FromHexString('#e9a83b');
    this.handleMaterial.diffuseColor = this.handleMaterial.emissiveColor;
    this.hoverMaterial = new StandardMaterial('SubD hover selection', editor.scene);
    this.hoverMaterial.disableLighting = true;
    this.hoverMaterial.emissiveColor = Color3.FromHexString('#e9a83b');
    this.hoverMaterial.diffuseColor = this.hoverMaterial.emissiveColor;
    this.hoverMaterial.alpha = 0.3;
    this.hoverMaterial.backFaceCulling = false;
    this.hoverMaterial.zOffset = -2;
    this.hoverSurface = new Mesh('SubD hover face', editor.scene);
    this.hoverSurface.material = this.hoverMaterial;
    this.hoverSurface.isPickable = false;
    this.hoverSurface.setEnabled(false);
    editor.overlays.add(this.hoverSurface);
    try {
      for (const abstract of meshes) this.records.push(this.createRecord(abstract as Mesh));
      this.softRadius = this.softRadiusMax * 0.25;
      this.refresh();
      this.observePointers();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get softRadiusMax() {
    let max = 0;
    for (const record of this.records) {
      const p = record.controlPositions;
      const min = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      const worldScale = Math.cbrt(Math.abs(record.source.computeWorldMatrix(true).determinant())) || 1;
      for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p[i + c]);
        high[c] = Math.max(high[c], p[i + c]);
      }
      max = Math.max(max, (high[0] - min[0]) * worldScale, (high[1] - min[1]) * worldScale, (high[2] - min[2]) * worldScale);
    }
    return Math.max(max, 0.01);
  }

  pickFace(x: number, y: number) {
    let best: { record: CageRecord; mesh: Mesh; faceId: number; distance: number; point: Vector3 } | null = null;
    const ray = this.editor.scene.createPickingRay(x, y, Matrix.Identity(), this.editor.camera);
    const localHit = Vector3.Zero(), worldHit = Vector3.Zero();
    for (const record of this.records) {
      if (!record.source.isVisible) continue;
      const positions = record.source.getVerticesData('position')!, indices = record.source.getIndices()!;
      const world = record.source.computeWorldMatrix(true), inverse = world.clone().invert();
      const origin = Vector3.TransformCoordinates(ray.origin, inverse);
      const direction = Vector3.TransformNormal(ray.direction, inverse).normalize();
      for (let faceId = 0; faceId < indices.length / 3; faceId++) {
        const distance = rayTriangle(positions, indices[faceId * 3], indices[faceId * 3 + 1], indices[faceId * 3 + 2], origin, direction);
        if (distance === null) continue;
        localHit.set(origin.x + direction.x * distance, origin.y + direction.y * distance, origin.z + direction.z * distance);
        Vector3.TransformCoordinatesToRef(localHit, world, worldHit);
        const worldDistance = Vector3.Distance(ray.origin, worldHit);
        if (!best || worldDistance < best.distance) best = { record, mesh: record.source, faceId, distance: worldDistance, point: worldHit.clone() };
      }
    }
    return best;
  }

  isCageSurfaceAt(x: number, y: number) {
    return !!this.pickFace(x, y);
  }

  private pickContext(x: number, y: number, pointerType: string): CageContext | null {
    const hit = this.pickFace(x, y);
    if (!hit) return null;
    const scene = this.editor.scene, engine = scene.getEngine(), canvas = engine.getRenderingCanvas();
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return null;
    this.viewport.x = 0; this.viewport.y = 0;
    this.viewport.width = engine.getRenderWidth(); this.viewport.height = engine.getRenderHeight();
    const transform = scene.getTransformMatrix();
    Vector3.ProjectToRef(hit.point, Matrix.IdentityReadOnly, transform, this.viewport, this.projected);
    const hitDepth = this.projected.z;
    const scaleX = canvas.clientWidth / this.viewport.width, scaleY = canvas.clientHeight / this.viewport.height;
    const pointRadius = pointerType === 'touch' ? 22 : 14;
    const edgeRadius = pointerType === 'touch' ? 18 : 12;
    let nearestVertex: { record: CageRecord; vertex: number; distance: number } | null = null;
    let nearestEdge: { record: CageRecord; a: number; b: number; t: number; distance: number } | null = null;
    const worldPoint = Vector3.Zero();
    for (const record of this.records) {
      if (!record.source.isVisible) continue;
      const world = record.source.computeWorldMatrix(true), screen = record.projected;
      for (let vertex = 0; vertex < record.representative.length; vertex++) {
        const at = vertex * 3;
        Vector3.TransformCoordinatesFromFloatsToRef(
          record.controlPositions[at], record.controlPositions[at + 1], record.controlPositions[at + 2], world, worldPoint,
        );
        Vector3.ProjectToRef(worldPoint, Matrix.IdentityReadOnly, transform, this.viewport, this.projected);
        screen[at] = this.projected.x * scaleX;
        screen[at + 1] = this.projected.y * scaleY;
        screen[at + 2] = this.projected.z;
        const dx = screen[at] - x, dy = screen[at + 1] - y, distance = dx * dx + dy * dy;
        if (this.projected.z >= 0 && this.projected.z <= 1 && this.projected.z <= hitDepth + 0.01
          && distance <= pointRadius * pointRadius && (!nearestVertex || distance < nearestVertex.distance)) {
          nearestVertex = { record, vertex, distance };
        }
      }
    }
    for (const record of this.records) {
      if (!record.source.isVisible) continue;
      const screen = record.projected, cache = this.getFaceCache(record);
      for (const edge of cache.edges) {
        const a = edge.a * 3, b = edge.b * 3;
        if (screen[a + 2] > hitDepth + 0.01 || screen[b + 2] > hitDepth + 0.01) continue;
        const closest = segmentDistance(x, y, screen[a], screen[a + 1], screen[b], screen[b + 1]);
        const edgeLength = Math.hypot(screen[b] - screen[a], screen[b + 1] - screen[a + 1]);
        const endpointPadding = edgeLength > 0 ? Math.min(0.25, pointRadius / edgeLength) : 0.5;
        if (closest.t < endpointPadding || closest.t > 1 - endpointPadding) continue;
        if (closest.distance <= edgeRadius * edgeRadius && (!nearestEdge || closest.distance < nearestEdge.distance)) {
          nearestEdge = { record, a: edge.a, b: edge.b, t: closest.t, distance: closest.distance };
        }
      }
    }
    if (nearestVertex && (!nearestEdge || nearestVertex.distance <= nearestEdge.distance)) {
      const { record, vertex } = nearestVertex, at = vertex * 3;
      const world = record.source.computeWorldMatrix(true);
      Vector3.TransformCoordinatesFromFloatsToRef(
        record.controlPositions[at], record.controlPositions[at + 1], record.controlPositions[at + 2], world, worldPoint,
      );
      return { kind: 'vertex', record, vertices: [vertex], anchor: vertex, faces: [], point: worldPoint.clone() };
    }
    if (nearestEdge) {
      const { record, a, b, t } = nearestEdge, world = record.source.computeWorldMatrix(true);
      const pa = Vector3.FromArray(record.controlPositions, a * 3), pb = Vector3.FromArray(record.controlPositions, b * 3);
      const localPoint = Vector3.Lerp(pa, pb, t);
      Vector3.TransformCoordinatesToRef(localPoint, world, worldPoint);
      return { kind: 'edge', record, vertices: [a, b], anchor: t < 0.5 ? a : b, faces: [], point: worldPoint.clone() };
    }

    const cache = this.getFaceCache(hit.record), patch = cache.patches[cache.patchByFace[hit.faceId]];
    if (!patch) return null;
    const screen = hit.record.projected;
    let anchor = patch.vertices[0], nearest = Infinity;
    for (const vertex of patch.vertices) {
      const at = vertex * 3, dx = screen[at] - x, dy = screen[at + 1] - y, distance = dx * dx + dy * dy;
      if (distance < nearest) { anchor = vertex; nearest = distance; }
    }
    return {
      kind: 'face', record: hit.record, vertices: patch.vertices, anchor, faces: patch.faces, point: hit.point,
    };
  }

  private getFaceCache(record: CageRecord): FaceCache {
    if (record.faceCache) return record.faceCache;
    const mesh = record.source, indices = mesh.getIndices()!, positions = mesh.getVerticesData('position')!;
    const world = mesh.computeWorldMatrix(true), faceCount = indices.length / 3;
    const centers = new Float32Array(faceCount * 3), normals = new Float32Array(faceCount * 3);
    const a = Vector3.Zero(), b = Vector3.Zero(), c = Vector3.Zero(), ab = Vector3.Zero(), ac = Vector3.Zero(), normal = Vector3.Zero();
    for (let face = 0; face < faceCount; face++) {
      const offset = face * 3;
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[indices[offset] * 3], positions[indices[offset] * 3 + 1], positions[indices[offset] * 3 + 2], world, a,
      );
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[indices[offset + 1] * 3], positions[indices[offset + 1] * 3 + 1], positions[indices[offset + 1] * 3 + 2], world, b,
      );
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[indices[offset + 2] * 3], positions[indices[offset + 2] * 3 + 1], positions[indices[offset + 2] * 3 + 2], world, c,
      );
      b.subtractToRef(a, ab); c.subtractToRef(a, ac);
      Vector3.CrossToRef(ab, ac, normal);
      if (normal.lengthSquared() > 1e-12) normal.normalize();
      centers[offset] = (a.x + b.x + c.x) / 3;
      centers[offset + 1] = (a.y + b.y + c.y) / 3;
      centers[offset + 2] = (a.z + b.z + c.z) / 3;
      normals[offset] = normal.x; normals[offset + 1] = normal.y; normals[offset + 2] = normal.z;
    }
    const boundsMin = [Infinity, Infinity, Infinity], boundsMax = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < record.representative.length; vertex++) {
      const offset = vertex * 3;
      Vector3.TransformCoordinatesFromFloatsToRef(
        record.controlPositions[offset], record.controlPositions[offset + 1], record.controlPositions[offset + 2], world, a,
      );
      boundsMin[0] = Math.min(boundsMin[0], a.x); boundsMin[1] = Math.min(boundsMin[1], a.y); boundsMin[2] = Math.min(boundsMin[2], a.z);
      boundsMax[0] = Math.max(boundsMax[0], a.x); boundsMax[1] = Math.max(boundsMax[1], a.y); boundsMax[2] = Math.max(boundsMax[2], a.z);
    }
    const tolerance = Math.max(boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2], 0.01) * 1e-4;
    const patchByFace = new Int32Array(faceCount).fill(-1), patches: FacePatch[] = [], queue = new Uint32Array(faceCount);
    for (let face = 0; face < faceCount; face++) {
      if (patchByFace[face] >= 0) continue;
      const patchId = patches.length, faceIds: number[] = [], vertices = new Set<number>();
      let head = 0, tail = 0;
      queue[tail++] = face; patchByFace[face] = patchId;
      while (head < tail) {
        const current = queue[head++], offset = current * 3;
        faceIds.push(current);
        for (let j = 0; j < 3; j++) vertices.add(record.topology.weld[indices[current * 3 + j]]);
        for (let k = record.topology.offsets[current]; k < record.topology.offsets[current + 1]; k++) {
          const neighbor = record.topology.list[k];
          if (patchByFace[neighbor] >= 0) continue;
          const other = neighbor * 3;
          const dot = Math.abs(
            normals[offset] * normals[other] + normals[offset + 1] * normals[other + 1] + normals[offset + 2] * normals[other + 2],
          );
          const distance = Math.abs(
            (centers[other] - centers[offset]) * normals[offset]
            + (centers[other + 1] - centers[offset + 1]) * normals[offset + 1]
            + (centers[other + 2] - centers[offset + 2]) * normals[offset + 2],
          );
          if (dot < 0.9995 || distance > tolerance) continue;
          patchByFace[neighbor] = patchId;
          queue[tail++] = neighbor;
        }
      }
      patches.push({ faces: faceIds, vertices: [...vertices] });
    }
    const edgeMap = new Map<string, { a: number; b: number; faces: number[] }>();
    for (let face = 0; face < faceCount; face++) for (let j = 0; j < 3; j++) {
      const a = record.topology.weld[indices[face * 3 + j]], b = record.topology.weld[indices[face * 3 + (j + 1) % 3]];
      if (a === b) continue;
      const key = edgeKey(a, b);
      let edge = edgeMap.get(key);
      if (!edge) edgeMap.set(key, edge = { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edge.faces.push(face);
    }
    const edges: CageEdge[] = [];
    for (const edge of edgeMap.values()) {
      if (edge.faces.length > 1 && edge.faces.every((face) => patchByFace[face] === patchByFace[edge.faces[0]])) continue;
      edges.push({ a: edge.a, b: edge.b });
    }
    return record.faceCache = { patches, patchByFace, edges };
  }

  private observePointers() {
    const scene = this.editor.scene;
    const observer = scene.onPrePointerObservable.add((info) => {
      const event = info.event as PointerEvent;
      if (this.contextDrag) {
        if (event.pointerId !== this.contextDrag.pointerId) {
          if (info.type === PointerEventTypes.POINTERDOWN) info.skipOnPointerObservable = true;
          return;
        }
        if (info.type === PointerEventTypes.POINTERMOVE) {
          const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), this.editor.camera);
          const point = rayPlanePoint(ray.origin, ray.direction, this.contextDrag.point, this.contextDrag.normal);
          if (point) {
            const delta = point.subtract(this.contextDrag.last);
            this.contextDrag.last.copyFrom(point);
            this.moveDrag(delta);
          }
          info.skipOnPointerObservable = true;
        } else if (info.type === PointerEventTypes.POINTERUP) {
          info.skipOnPointerObservable = true;
          this.endContextDrag(false);
        }
        return;
      }

      if (info.type === PointerEventTypes.POINTERMOVE) {
        if ((event.pointerType === 'pen' || event.pointerType === 'mouse') && event.buttons === 0) {
          this.setHoverContext(this.pickContext(scene.pointerX, scene.pointerY, event.pointerType));
        }
        return;
      }
      if (info.type !== PointerEventTypes.POINTERDOWN || event.button !== 0) return;
      const x = scene.pointerX, y = scene.pointerY;
      const context = this.pickContext(x, y, event.pointerType);
      if (!context) { this.setHoverContext(null); return; }
      const additive = event.shiftKey || this.editor.inputModifiers.shift;
      this.selectContext(context, additive);
      this.setHoverContext(null);
      info.skipOnPointerObservable = true;
      event.preventDefault();
      if (additive) return;

      this.beginSelectedDrag(context.record, context.anchor);
      if (!this.drag) return;
      const normal = this.editor.camera.getForwardRay().direction.clone();
      const ray = scene.createPickingRay(x, y, Matrix.Identity(), this.editor.camera);
      const start = rayPlanePoint(ray.origin, ray.direction, context.point, normal);
      if (!start) { this.endDrag(true); return; }
      this.contextDrag = { pointerId: event.pointerId, point: context.point.clone(), normal, last: start };
      this.editor.camera.detachControl();
    });
    this.removePointerObserver = () => scene.onPrePointerObservable.remove(observer);
    const canvas = scene.getEngine().getRenderingCanvas();
    if (canvas) {
      const leave = () => { if (!this.contextDrag) this.setHoverContext(null); };
      canvas.addEventListener('pointerleave', leave);
      this.removePointerLeave = () => canvas.removeEventListener('pointerleave', leave);
    }
  }

  private endContextDrag(cancel: boolean) {
    if (!this.contextDrag) return;
    this.contextDrag = null;
    this.endDrag(cancel);
    this.editor.camera.attachControl(true);
  }

  private setHoverContext(context: CageContext | null) {
    if (sameContext(this.hoverContext, context)) return;
    this.hoverContext = context;
    this.hoverSurface?.setEnabled(false);
    this.hoverEdge?.setEnabled(false);
    if (context?.kind === 'edge') {
      const world = context.record.source.computeWorldMatrix(true);
      const a = Vector3.TransformCoordinates(Vector3.FromArray(context.record.controlPositions, context.vertices[0] * 3), world);
      const b = Vector3.TransformCoordinates(Vector3.FromArray(context.record.controlPositions, context.vertices[1] * 3), world);
      const lines = [[a, b]];
      if (!this.hoverEdge) {
        this.hoverEdge = CreateLineSystem('SubD hover edge', { lines, updatable: true }, this.editor.scene);
        this.hoverEdge.material = this.handleMaterial;
        this.hoverEdge.isPickable = false;
        this.editor.overlays.add(this.hoverEdge);
      } else CreateLineSystem(this.hoverEdge.name, { lines, instance: this.hoverEdge }, this.editor.scene);
      this.hoverEdge.setEnabled(true);
    } else if (context?.kind === 'face') {
      this.updateHoverSurface(context);
    }
    this.updateHandleSelection();
    this.editor.invalidate();
  }

  private updateHoverSurface(context: CageContext) {
    const sourcePositions = context.record.source.getVerticesData('position')!;
    const sourceIndices = context.record.source.getIndices()!;
    const positions = Float32Array.from(sourcePositions), indices = new Uint32Array(context.faces.length * 3);
    for (let i = 0; i < context.faces.length; i++) {
      const face = context.faces[i];
      indices.set(sourceIndices.slice(face * 3, face * 3 + 3), i * 3);
    }
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    const overlay = this.hoverSurface!;
    overlay.setVerticesData('position', positions, true);
    overlay.setVerticesData('normal', normals, true);
    overlay.setIndices(indices, positions.length / 3, true);
    copyTransform(context.record.source, overlay);
    overlay.isVisible = true;
    overlay.setEnabled(true);
  }

  exportExclusions() {
    return [
      ...this.records.flatMap((record) => [record.source, record.wire, ...record.handles]),
      ...(this.hoverSurface ? [this.hoverSurface] : []),
      ...(this.hoverEdge ? [this.hoverEdge] : []),
    ];
  }

  setVisible(visible: boolean) {
    for (const record of this.records) {
      record.smooth.isVisible = visible;
      record.wire.isVisible = visible;
      for (const handle of record.handles) handle.isVisible = visible;
    }
    if (this.hoverSurface) this.hoverSurface.isVisible = visible && this.hoverContext?.kind === 'face';
    if (this.hoverEdge) this.hoverEdge.isVisible = visible && this.hoverContext?.kind === 'edge';
  }

  clearPointSelection() {
    if (!this.selectedPoints.size) return;
    this.selectedPoints.clear();
    this.updateHandleSelection();
    this.editor.invalidate();
  }

  refresh() {
    this.setHoverContext(null);
    for (const record of this.records) {
      const topology = buildTopology(record.source);
      const positions = weldedPositions(record.source, topology);
      record.faceCache = null;
      if (record.projected.length !== positions.representative.length * 3) record.projected = new Float32Array(positions.representative.length * 3);
      if (!sameTopology(record.topology, topology)) {
        this.selectedPoints.delete(record);
        record.handles.forEach((handle) => handle.dispose());
        record.handles = [];
      }
      record.topology = topology;
      record.controlPositions = positions.positions;
      record.representative = positions.representative;
      updateWire(record, this.wireMaterial);
      updateSmooth(record);
      if (!record.handles.length) this.createHandles(record);
      else this.updateHandles(record);
    }
    this.editor.invalidate();
  }

  setExtrusionDistance(distance: number) {
    this.extrudeDistance = distance;
    if (!this.selection.count) { this.cancelExtrusion(); return; }
    if (!this.extrusion) {
      this.extrusion = [...this.selection.faces].filter(([, faces]) => faces.size).map(([mesh, faces]) => ({
        mesh,
        before: capturePart(mesh, true),
        faces: new Set(faces),
      }));
    }
    if (!this.extrusion.length) return;
    for (const item of this.extrusion) {
      const next = distance === 0 ? item.before : extrudeFaces(item.before, item.faces, distance);
      applyPart(item.mesh, next);
    }
    this.refresh();
    this.selection.refresh();
  }

  commitExtrusion() {
    const items = this.extrusion;
    this.extrusion = null;
    if (!items) return;
    if (Math.abs(this.extrudeDistance) < 1e-8) {
      for (const item of items) applyPart(item.mesh, item.before);
      this.refresh();
      this.selection.refresh();
      return;
    }
    const result = this.entity.meshes.map((abstract) => capturePart(abstract as Mesh, true));
    for (const item of items) applyPart(item.mesh, item.before);
    this.refresh();
    this.selection.refresh();
    this.separator.applyGeometry(result);
    this.extrudeDistance = 0;
  }

  cancelExtrusion() {
    const items = this.extrusion;
    this.extrusion = null;
    if (!items) return;
    for (const item of items) applyPart(item.mesh, item.before);
    this.refresh();
    this.selection.refresh();
  }

  dispose() {
    this.endDrag(true);
    this.endContextDrag(true);
    this.setHoverContext(null);
    this.removePointerObserver?.();
    this.removePointerObserver = null;
    this.removePointerLeave?.();
    this.removePointerLeave = null;
    this.cancelExtrusion();
    for (const record of this.records) {
      record.handles.forEach((handle) => handle.dispose());
      record.wire.dispose();
      record.smooth.dispose();
      record.source.visibility = record.originalVisibility;
      record.source.isPickable = record.originalPickable;
    }
    this.records.length = 0;
    this.selectedPoints.clear();
    if (this.hoverSurface) {
      this.editor.overlays.delete(this.hoverSurface);
      this.hoverSurface.dispose();
      this.hoverSurface = null;
    }
    if (this.hoverEdge) {
      this.editor.overlays.delete(this.hoverEdge);
      this.hoverEdge.dispose();
      this.hoverEdge = null;
    }
    this.wireMaterial.dispose();
    this.handleMaterial.dispose();
    this.hoverMaterial.dispose();
  }

  private createRecord(source: Mesh): CageRecord {
    const topology = buildTopology(source), data = weldedPositions(source, topology);
    const smooth = new Mesh(`${source.name} SubD`, this.editor.scene);
    const lines = edgeLines(data.positions, topology, source.getIndices()!);
    const wire = CreateLineSystem(`${source.name} SubD cage`, { lines, updatable: true }, this.editor.scene);
    wire.material = this.wireMaterial;
    wire.isPickable = false;
    wire.isVisible = source.isVisible;
    copyTransform(source, smooth);
    copyTransform(source, wire);
    smooth.material = source.material;
    smooth.isPickable = false;
    smooth.isVisible = source.isVisible;
    smooth.visibility = source.visibility;
    smooth.receiveShadows = source.receiveShadows;
    const record: CageRecord = {
      source, smooth, wire, topology, controlPositions: data.positions, representative: data.representative,
      handles: [], originalVisibility: source.visibility, originalPickable: source.isPickable,
      edgeCount: lines.length, handleSize: 0, faceCache: null, projected: new Float32Array(data.representative.length * 3),
    };
    source.visibility = 0;
    source.isPickable = true;
    updateSmooth(record);
    this.createHandles(record);
    return record;
  }

  private createHandles(record: CageRecord) {
    const world = record.source.computeWorldMatrix(true);
    const scale = maxWorldScale(world);
    const size = Math.max(controlExtent(record.controlPositions) * 0.04, 0.025) * scale;
    record.handleSize = size * 2;
    for (let w = 0; w < record.representative.length; w++) {
      const handle = CreateSphere('SubD control point', { diameter: 1, segments: 8 }, this.editor.scene);
      handle.material = this.handleMaterial;
      handle.isPickable = false;
      handle.isVisible = record.source.isVisible;
      handle.scaling.setAll(record.handleSize * this.handleScale(record, w));
      Vector3.TransformCoordinatesFromFloatsToRef(
        record.controlPositions[w * 3], record.controlPositions[w * 3 + 1], record.controlPositions[w * 3 + 2], world, handle.position,
      );
      record.handles.push(handle);
    }
  }

  private updateHandles(record: CageRecord) {
    const world = record.source.computeWorldMatrix(true);
    for (let w = 0; w < record.handles.length; w++) {
      const at = w * 3;
      Vector3.TransformCoordinatesFromFloatsToRef(
        record.controlPositions[at], record.controlPositions[at + 1], record.controlPositions[at + 2], world, record.handles[w].position,
      );
      record.handles[w].scaling.setAll(record.handleSize * this.handleScale(record, w));
    }
  }

  private updateHandleSelection() {
    for (const record of this.records) {
      for (let vertex = 0; vertex < record.handles.length; vertex++) {
        record.handles[vertex].scaling.setAll(record.handleSize * this.handleScale(record, vertex));
      }
    }
  }

  private handleScale(record: CageRecord, vertex: number) {
    if (this.selectedPoints.get(record)?.has(vertex)) return 1.5;
    if (this.hoverContext?.record === record && this.hoverContext.vertices.includes(vertex)) return 1.25;
    return 1;
  }

  private selectPoints(record: CageRecord, vertices: number[], additive: boolean) {
    if (additive) {
      let selected = this.selectedPoints.get(record);
      const remove = vertices.every((vertex) => selected?.has(vertex));
      if (!selected) this.selectedPoints.set(record, selected = new Set());
      for (const vertex of vertices) {
        if (remove) selected.delete(vertex);
        else selected.add(vertex);
      }
      if (!selected.size) this.selectedPoints.delete(record);
    } else {
      this.selectedPoints.clear();
      if (vertices.length) this.selectedPoints.set(record, new Set(vertices));
    }
    this.updateHandleSelection();
    this.editor.invalidate();
  }

  private selectContext(context: CageContext, additive: boolean) {
    const alreadySelected = context.vertices.every((vertex) => this.selectedPoints.get(context.record)?.has(vertex));
    if (additive) this.selectPoints(context.record, context.vertices, true);
    else if (!alreadySelected) this.selectPoints(context.record, context.vertices, false);
    if (context.kind !== 'face') {
      if (!additive && !alreadySelected) this.clearFaceSelection();
      return;
    }
    if (!additive && alreadySelected) return;
    const faceSet = this.selection.faces.get(context.record.source);
    if (!faceSet) return;
    if (!additive) this.selection.clear();
    else this.selection.checkpoint();
    const remove = additive && context.faces.every((face) => faceSet.has(face));
    this.selection.apply(context.record.source, context.faces, !remove);
    this.selection.refresh();
  }

  private clearFaceSelection() {
    if (this.selection.count) this.selection.clear();
  }

  private beginSelectedDrag(record: CageRecord, weldedVertex: number) {
    const rootWorld = this.entity.root.computeWorldMatrix(true).clone();
    const rootInverse = rootWorld.clone().invert();
    const symmetry = this.symmetry;
    const clickedPairing = this.findMirrorSeeds(record, weldedVertex, rootInverse);
    const grouped = new Map<CageRecord, { primary: Set<number>; mirror: Set<number> }>();
    for (const [selectedRecord, selectedVertices] of this.selectedPoints) {
      for (const vertex of selectedVertices) {
        const pairing = this.findMirrorSeeds(selectedRecord, vertex, rootInverse);
        for (const seed of pairing.seeds) {
          let group = grouped.get(seed.record);
          if (!group) grouped.set(seed.record, group = { primary: new Set(), mirror: new Set() });
          (seed.mirrored ? group.mirror : group.primary).add(seed.vertex);
        }
      }
    }
    const targets: DragTarget[] = [];
    for (const [targetRecord, seeds] of grouped) {
      const topology = buildTopology(targetRecord.source), deform = new Deform(targetRecord.source, topology);
      const world = targetRecord.source.computeWorldMatrix(true);
      const scale = Math.cbrt(Math.abs(world.determinant())) || 1;
      const primaryWeights = topologyWeights(topology, targetRecord.source.getIndices()!, deform.positions, [...seeds.primary], this.softRadius, scale);
      const mirrorWeights = seeds.mirror.size
        ? topologyWeights(topology, targetRecord.source.getIndices()!, deform.positions, [...seeds.mirror], this.softRadius, scale)
        : new Float32Array(primaryWeights.length);
      const sides = new Int8Array(deform.positions.length / 3), vertices: number[] = [];
      const worldPoint = Vector3.Zero(), rootPoint = Vector3.Zero();
      for (let v = 0; v < sides.length; v++) {
        const weight = Math.max(primaryWeights[v], mirrorWeights[v]);
        if (weight <= 0) continue;
        if (symmetry && !clickedPairing.centerSeed) {
          Vector3.TransformCoordinatesFromFloatsToRef(
            deform.positions[v * 3], deform.positions[v * 3 + 1], deform.positions[v * 3 + 2], world, worldPoint,
          );
          Vector3.TransformCoordinatesToRef(worldPoint, rootInverse, rootPoint);
          sides[v] = Math.abs(rootPoint.x) <= clickedPairing.tolerance ? 0 : Math.sign(rootPoint.x) === clickedPairing.primarySide ? 1 : -1;
        }
        vertices.push(v);
      }
      targets.push({
        record: targetRecord, deform, before: deform.startState(), primaryWeights, mirrorWeights,
        vertices: Uint32Array.from(vertices), sides, sourceInverse: world.clone().invert(),
      });
    }
    this.drag = {
      targets, rootWorld, rootInverse, symmetry, centerSeed: clickedPairing.centerSeed,
      delta: Vector3.Zero(),
    };
    this.selection.refresh();
  }

  private moveDrag(worldDelta: Vector3) {
    const drag = this.drag;
    if (!drag) return;
    drag.delta.addInPlace(Vector3.TransformNormal(worldDelta, drag.rootInverse));
    const rootDelta = Vector3.Zero(), worldDeltaLocal = Vector3.Zero(), localDelta = Vector3.Zero();
    for (const target of drag.targets) {
      const positions = target.deform.positions, base = target.before.positions;
      for (const vertex of target.vertices) {
        const side = target.sides[vertex];
        let weight = target.primaryWeights[vertex];
        if (drag.symmetry && side < 0) weight = target.mirrorWeights[vertex];
        else if (drag.symmetry && side === 0) weight = Math.max(weight, target.mirrorWeights[vertex]);
        if (weight <= 0) continue;
        const deltaX = drag.symmetry && (drag.centerSeed || side === 0) ? 0
          : drag.symmetry && side < 0 ? -drag.delta.x : drag.delta.x;
        rootDelta.set(deltaX, drag.delta.y, drag.delta.z);
        Vector3.TransformNormalToRef(rootDelta, drag.rootWorld, worldDeltaLocal);
        Vector3.TransformNormalToRef(worldDeltaLocal, target.sourceInverse, localDelta);
        const at = vertex * 3;
        positions[at] = base[at] + localDelta.x * weight;
        positions[at + 1] = base[at + 1] + localDelta.y * weight;
        positions[at + 2] = base[at + 2] + localDelta.z * weight;
        target.deform.touch(vertex);
      }
      target.deform.updateNormals(target.vertices);
      target.deform.upload();
      target.record.source.refreshBoundingInfo();
    }
    this.refresh();
    this.selection.refresh();
  }

  private endDrag(cancel = false) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (cancel) {
      for (const target of drag.targets) Deform.restore(target.record.source, target.before);
      this.refresh();
      this.selection.refresh();
      return;
    }
    const changes: { mesh: Mesh; before: ReturnType<Deform['startState']>; after: ReturnType<Deform['state']> }[] = [];
    for (const target of drag.targets) {
      target.deform.finish();
      const after = target.deform.state();
      if (positionsDiffer(target.before.positions, after.positions)) changes.push({ mesh: target.record.source, before: target.before, after });
    }
    if (!changes.length) return;
    recordDeform(this.editor, this.entity, changes, () => {
      if (this.separator.subdivision !== this) return;
      this.selection.invalidateTopology();
      this.selection.refresh();
      this.refresh();
    });
  }

  private findMirrorSeeds(record: CageRecord, weldedVertex: number, rootInverse: Matrix) {
    const primary = { record, vertex: weldedVertex, mirrored: false };
    if (!this.symmetry) return { seeds: [primary], centerSeed: false, primarySide: 0, tolerance: 0 };
    const owners: { record: CageRecord; vertex: number }[] = [];
    const points: number[] = [];
    let selected = -1;
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    const worldPoint = Vector3.Zero(), point = Vector3.Zero();
    for (const candidate of this.records) {
      const world = candidate.source.computeWorldMatrix(true);
      for (let vertex = 0; vertex < candidate.representative.length; vertex++) {
        const at = vertex * 3;
        Vector3.TransformCoordinatesFromFloatsToRef(
          candidate.controlPositions[at], candidate.controlPositions[at + 1], candidate.controlPositions[at + 2], world, worldPoint,
        );
        Vector3.TransformCoordinatesToRef(worldPoint, rootInverse, point);
        const index = points.length / 3;
        points.push(point.x, point.y, point.z);
        owners.push({ record: candidate, vertex });
        if (candidate === record && vertex === weldedVertex) selected = index;
        low[0] = Math.min(low[0], point.x); low[1] = Math.min(low[1], point.y); low[2] = Math.min(low[2], point.z);
        high[0] = Math.max(high[0], point.x); high[1] = Math.max(high[1], point.y); high[2] = Math.max(high[2], point.z);
      }
    }
    if (selected < 0) return { seeds: [primary], centerSeed: false, primarySide: 0, tolerance: 0 };
    const tolerance = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2], 0.01) * 1e-4;
    const pointData = Float32Array.from(points);
    const mirror = mirrorVertexX(pointData, selected, tolerance);
    const primarySide = Math.sign(pointData[selected * 3]);
    const centerSeed = mirror === selected;
    return {
      seeds: mirror === null || mirror === selected ? [primary] : [primary, { ...owners[mirror], mirrored: true }],
      centerSeed, primarySide, tolerance,
    };
  }
}

function weldedPositions(mesh: Mesh, topology: FaceTopology) {
  const source = Float32Array.from(mesh.getVerticesData('position')!);
  const positions = new Float32Array((topology.vertexStart.length - 1) * 3);
  const representative = new Int32Array(topology.vertexStart.length - 1).fill(-1);
  for (let i = 0; i < topology.weld.length; i++) {
    const w = topology.weld[i];
    if (representative[w] >= 0) continue;
    representative[w] = i;
    positions.set(source.subarray(i * 3, i * 3 + 3), w * 3);
  }
  return { positions, representative };
}

function edgeLines(positions: Float32Array, topology: FaceTopology, indices: ArrayLike<number>) {
  const edges = new Set<string>(), lines: Vector3[][] = [];
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = topology.weld[indices[i + j]], b = topology.weld[indices[i + (j + 1) % 3]];
    const key = edgeKey(a, b);
    if (a === b || edges.has(key)) continue;
    edges.add(key);
    lines.push([Vector3.FromArray(positions, a * 3), Vector3.FromArray(positions, b * 3)]);
  }
  return lines;
}

function updateWire(record: CageRecord, material: StandardMaterial) {
  const lines = edgeLines(record.controlPositions, record.topology, record.source.getIndices()!);
  if (lines.length !== record.edgeCount) {
    record.wire.dispose();
    record.wire = CreateLineSystem(`${record.source.name} SubD cage`, { lines, updatable: true }, record.source.getScene());
    record.wire.material = material;
    record.wire.isPickable = false;
    record.wire.isVisible = record.source.isVisible;
    copyTransform(record.source, record.wire);
    record.edgeCount = lines.length;
  } else CreateLineSystem(record.wire.name, { lines, instance: record.wire }, record.source.getScene());
}

function updateSmooth(record: CageRecord) {
  const output = subdividedOutput(record.source);
  const data = new VertexData();
  data.positions = output.positions;
  data.normals = output.normals;
  data.indices = output.indices;
  if (output.uvs) data.uvs = output.uvs;
  data.applyToMesh(record.smooth, true);
  record.smooth.releaseSubMeshes();
  for (const range of output.materials) if (range.count) new SubMesh(range.material, 0, record.smooth.getTotalVertices(), range.start, range.count, record.smooth);
  record.smooth.material = record.source.material;
  record.smooth.refreshBoundingInfo();
  record.smooth.computeWorldMatrix(true);
}

function subdividedOutput(mesh: Mesh): SubDOutput {
  const topology = buildTopology(mesh), data = weldedPositions(mesh, topology);
  const sourceIndices = mesh.getIndices()!, sourceUV = mesh.getVerticesData('uv');
  const faces: PolyFace[] = [];
  for (let f = 0; f < sourceIndices.length / 3; f++) {
    const vertices = [0, 1, 2].map((j) => topology.weld[sourceIndices[f * 3 + j]]);
    if (new Set(vertices).size < 3) continue;
    const sub = mesh.subMeshes.find((s) => f * 3 >= s.indexStart && f * 3 < s.indexStart + s.indexCount);
    const uv = sourceUV ? vertices.map((_, j) => {
      const index = sourceIndices[f * 3 + j] * 2;
      return [sourceUV[index], sourceUV[index + 1]];
    }).flat() : null;
    faces.push({ vertices, material: sub?.materialIndex ?? 0, uv });
  }
  let cage: CageMeshData = { positions: data.positions, faces };
  for (let level = 0; level < SUBDIVISION_LEVEL; level++) cage = catmullClark(cage);

  const globalIndices: number[] = [], faceMaterials: number[] = [];
  for (const face of cage.faces) for (let i = 1; i < face.vertices.length - 1; i++) {
    globalIndices.push(face.vertices[0], face.vertices[i], face.vertices[i + 1]);
    faceMaterials.push(face.material);
  }
  const globalNormals = new Float32Array(cage.positions.length);
  VertexData.ComputeNormals(cage.positions, globalIndices, globalNormals);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const face of cage.faces) for (let i = 1; i < face.vertices.length - 1; i++) {
    const corners = [0, i, i + 1];
    for (const corner of corners) {
      const vertex = face.vertices[corner], at = vertex * 3;
      positions.push(cage.positions[at], cage.positions[at + 1], cage.positions[at + 2]);
      normals.push(globalNormals[at], globalNormals[at + 1], globalNormals[at + 2]);
      if (face.uv) uvs.push(face.uv[corner * 2], face.uv[corner * 2 + 1]);
      indices.push(indices.length);
    }
  }
  const materials: SubDOutput['materials'] = [];
  let start = 0;
  for (let f = 1; f <= faceMaterials.length; f++) if (f === faceMaterials.length || faceMaterials[f] !== faceMaterials[start / 3]) {
    materials.push({ material: faceMaterials[start / 3] ?? 0, start, count: (f - start / 3) * 3 });
    start = f * 3;
  }
  return {
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices),
    uvs: uvs.length ? Float32Array.from(uvs) : undefined, materials,
  };
}

function extrudeFaces(part: MeshPart, selected: Set<number>, distance: number): MeshPart {
  const attributes = part.attributes, sourcePositions = attributes?.position;
  if (!attributes || !sourcePositions || !selected.size) return part;
  const positions = Float32Array.from(sourcePositions), indices = Uint32Array.from(part.indices), vertexCount = positions.length / 3;
  const topology = computeTopology(positions, indices), weld = topology.weld;
  const adjacent = new Map<string, number[]>();
  for (let f = 0; f < indices.length / 3; f++) for (let j = 0; j < 3; j++) {
    const a = weld[indices[f * 3 + j]], b = weld[indices[f * 3 + (j + 1) % 3]], key = edgeKey(a, b);
    const faces = adjacent.get(key) ?? [];
    faces.push(f); adjacent.set(key, faces);
  }
  const faceMaterials = new Int32Array(indices.length / 3);
  for (const range of part.materials) for (let i = range.start; i < range.start + range.count; i += 3) faceMaterials[i / 3] = range.material;
  const normals = new Float32Array(positions.length), duplicates = new Map<number, number>();
  const boundary: { a: number; b: number; material: number }[] = [];
  for (const f of selected) {
    const a = indices[f * 3], b = indices[f * 3 + 1], c = indices[f * 3 + 2];
    const ax = positions[b * 3] - positions[a * 3], ay = positions[b * 3 + 1] - positions[a * 3 + 1], az = positions[b * 3 + 2] - positions[a * 3 + 2];
    const bx = positions[c * 3] - positions[a * 3], by = positions[c * 3 + 1] - positions[a * 3 + 1], bz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (const vertex of [a, b, c]) {
      normals[vertex * 3] += nx; normals[vertex * 3 + 1] += ny; normals[vertex * 3 + 2] += nz;
      if (!duplicates.has(vertex)) duplicates.set(vertex, vertexCount + duplicates.size);
    }
    for (let j = 0; j < 3; j++) {
      const x = indices[f * 3 + j], y = indices[f * 3 + (j + 1) % 3];
      const around = adjacent.get(edgeKey(weld[x], weld[y])) ?? [];
      if (around.filter((other) => selected.has(other)).length === 1) boundary.push({ a: x, b: y, material: faceMaterials[f] });
    }
  }
  if (!duplicates.size) return part;
  const expandedAttributes: Record<string, Float32Array> = {};
  for (const [kind, values] of Object.entries(attributes)) {
    const stride = values.length / vertexCount, expanded = new Float32Array((vertexCount + duplicates.size) * stride);
    expanded.set(values);
    for (const [source, target] of duplicates) {
      for (let c = 0; c < stride; c++) expanded[target * stride + c] = values[source * stride + c];
    }
    expandedAttributes[kind] = expanded;
  }
  const expandedPositions = expandedAttributes.position;
  for (const [source, target] of duplicates) {
    const at = source * 3, to = target * 3, length = Math.hypot(normals[at], normals[at + 1], normals[at + 2]) || 1;
    expandedPositions[to] = positions[at] + normals[at] / length * distance;
    expandedPositions[to + 1] = positions[at + 1] + normals[at + 1] / length * distance;
    expandedPositions[to + 2] = positions[at + 2] + normals[at + 2] / length * distance;
  }
  for (const f of selected) for (let j = 0; j < 3; j++) {
    const at = f * 3 + j;
    indices[at] = duplicates.get(indices[at])!;
  }
  const allIndices = new Uint32Array(indices.length + boundary.length * 6);
  allIndices.set(indices);
  const sideMaterials: number[] = [];
  let cursor = indices.length;
  for (const edge of boundary) {
    const a = edge.a, b = edge.b, upperA = duplicates.get(a)!, upperB = duplicates.get(b)!;
    allIndices.set([a, b, upperB, a, upperB, upperA], cursor);
    cursor += 6;
    sideMaterials.push(edge.material, edge.material);
  }
  const allFaceMaterials = [...faceMaterials, ...sideMaterials], materials: MeshPart['materials'] = [];
  let startFace = 0;
  for (let f = 1; f <= allFaceMaterials.length; f++) if (f === allFaceMaterials.length || allFaceMaterials[f] !== allFaceMaterials[startFace]) {
    materials.push({ material: allFaceMaterials[startFace] ?? 0, start: startFace * 3, count: (f - startFace) * 3 });
    startFace = f;
  }
  const expandedNormals = new Float32Array(expandedPositions.length);
  VertexData.ComputeNormals(expandedPositions, allIndices, expandedNormals);
  expandedAttributes.normal = expandedNormals;
  return { ...part, indices: allIndices, materials, attributes: expandedAttributes };
}

function sameTopology(a: FaceTopology, b: FaceTopology) {
  if (a.weld.length !== b.weld.length || a.vertexStart.length !== b.vertexStart.length) return false;
  for (let i = 0; i < a.weld.length; i++) if (a.weld[i] !== b.weld[i]) return false;
  return true;
}

function copyTransform(source: Mesh, target: Mesh) {
  target.parent = source.parent;
  target.position.copyFrom(source.position);
  target.rotation.copyFrom(source.rotation);
  if (source.rotationQuaternion) target.rotationQuaternion = source.rotationQuaternion.clone();
  target.scaling.copyFrom(source.scaling);
  target.setPivotMatrix(source.getPivotMatrix().clone());
  target.computeWorldMatrix(true);
}

function maxWorldScale(world: Matrix) {
  return Math.max(
    Vector3.TransformNormal(Vector3.Right(), world).length(),
    Vector3.TransformNormal(Vector3.Up(), world).length(),
    Vector3.TransformNormal(Vector3.Forward(), world).length(),
  );
}

function controlExtent(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], positions[i + c]);
    max[c] = Math.max(max[c], positions[i + c]);
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function rayTriangle(positions: ArrayLike<number>, ai: number, bi: number, ci: number, origin: Vector3, direction: Vector3) {
  const a = ai * 3, b = bi * 3, c = ci * 3;
  const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
  const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-8) return null;
  const inverse = 1 / determinant, ox = origin.x - positions[a], oy = origin.y - positions[a + 1], oz = origin.z - positions[a + 2];
  const u = (ox * px + oy * py + oz * pz) * inverse;
  if (u < 0 || u > 1) return null;
  const qx = oy * e1z - oz * e1y, qy = oz * e1x - ox * e1z, qz = ox * e1y - oy * e1x;
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;
  if (v < 0 || u + v > 1) return null;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  return distance >= 0 ? distance : null;
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const t = length > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  const offsetX = x - (ax + dx * t), offsetY = y - (ay + dy * t);
  return { distance: offsetX * offsetX + offsetY * offsetY, t };
}

function rayPlanePoint(origin: Vector3, direction: Vector3, planePoint: Vector3, normal: Vector3) {
  const denominator = Vector3.Dot(direction, normal);
  if (Math.abs(denominator) < 1e-8) return null;
  const distance = Vector3.Dot(planePoint.subtract(origin), normal) / denominator;
  return distance >= 0 ? origin.add(direction.scale(distance)) : null;
}

function sameContext(a: CageContext | null, b: CageContext | null) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.record === b.record
    && a.vertices.length === b.vertices.length && a.faces.length === b.faces.length
    && a.vertices.every((vertex, i) => vertex === b.vertices[i])
    && a.faces.every((face, i) => face === b.faces[i]);
}

function positionsDiffer(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}
