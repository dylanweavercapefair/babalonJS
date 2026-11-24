import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Viewport } from '@babylonjs/core/Maths/math.viewport.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import '@babylonjs/core/Culling/ray.js';

const require = createRequire(import.meta.url), urls = new Map();
function moduleURL(filename) {
  filename = path.resolve(filename);
  if (urls.has(filename)) return urls.get(filename);
  let code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/from ['"]([^'"]+)['"]/g, (_, id) =>
    `from '${id.startsWith('.') ? moduleURL(path.resolve(path.dirname(filename), `${id}.ts`)) : pathToFileURL(require.resolve(id)).href}'`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  urls.set(filename, url);
  return url;
}

const editRoot = fileURLToPath(new URL('../src/edit/', import.meta.url));
const { SubDCage } = await import(moduleURL(path.join(editRoot, 'subdivision.ts')));
const { mirrorVertexX } = await import(moduleURL(path.join(editRoot, 'subdivisionMath.ts')));
const engine = new NullEngine({ renderWidth: 256, renderHeight: 256 });
const fakeCanvas = { clientWidth: 256, clientHeight: 256, addEventListener() {}, removeEventListener() {} };
engine.getRenderingCanvas = () => fakeCanvas;
const scene = new Scene(engine);
const camera = new ArcRotateCamera('camera', Math.PI / 2, Math.PI / 2, 6, Vector3.Zero(), scene);
scene.activeCamera = camera;

const root = new TransformNode('entity root', scene);
root.position.set(3, 2, -1);
root.rotation.y = 0.4;
camera.setTarget(root.position);
const mesh = CreateBox('symmetric cube', { size: 2 }, scene);
mesh.parent = root;
const entity = { root, meshes: [mesh], separation: null, rig: null };
const selection = { entity, count: 0, refresh() {}, invalidateTopology() {} };
const separator = { subdivision: null };
let history = null;
const editor = {
  scene, camera, inputModifiers: { shift: false }, overlays: { add() {}, delete() {} },
  invalidate() {}, notify() {}, refreshShadowCasters() {},
  record(command) { history = command; },
};

const cage = new SubDCage(editor, separator, selection);
separator.subdivision = cage;
try {
  cage.symmetry = true;
  cage.softRadius = 0;
  const record = cage.records[0];
  const selectPoint = (vertex, additive = false) => cage.selectContext({
    kind: 'vertex', record, vertices: [vertex], anchor: vertex, faces: [], point: Vector3.Zero(),
  }, additive);
  const beginPointDrag = (vertex) => {
    selectPoint(vertex);
    cage.beginSelectedDrag(record, vertex);
  };
  const faceCache = cage.getFaceCache(record);
  assert.equal(faceCache.patches.length, 6, 'each cube side is one coplanar face patch');
  assert.ok(faceCache.patches.every((patch) => patch.faces.length === 2), 'the two triangles on each cube side merge');
  assert.equal(faceCache.edges.length, 12, 'internal triangulation diagonals are not selectable cage edges');
  const viewport = new Viewport(0, 0, 256, 256);
  scene.updateTransformMatrix(true);
  const screen = (point) => {
    const world = Vector3.TransformCoordinates(point, root.computeWorldMatrix(true));
    const projected = Vector3.Project(world, Matrix.Identity(), scene.getTransformMatrix(), viewport);
    return [projected.x, projected.y];
  };
  const nearCorner = screen(new Vector3(0.99, 0.99, 1));
  assert.equal(cage.pickContext(nearCorner[0], nearCorner[1], 'pen')?.kind, 'vertex', 'hover near a cage point chooses the point');
  const edge = screen(new Vector3(-0.95, 0, 1));
  assert.equal(cage.pickContext(edge[0], edge[1], 'pen')?.kind, 'edge', 'hover along a cage edge chooses the edge');
  const face = screen(new Vector3(0.05, 0, 1));
  const faceContext = cage.pickContext(face[0], face[1], 'pen');
  assert.equal(faceContext?.kind, 'face', 'hover inside a flat face chooses the face patch');
  assert.equal(faceContext?.faces.length, 2, 'the face context includes both triangles of the planar patch');
  const seed = [...record.controlPositions].findIndex((_, i) => i % 3 === 0 && record.controlPositions[i] > 0) / 3;
  const mirror = mirrorVertexX(record.controlPositions, seed, 1e-4);
  assert.notEqual(mirror, null, 'the positive-side cage point has a matching negative-side point');
  assert.notEqual(mirror, seed, 'an off-axis point pairs with a distinct vertex');

  const primaryIndex = record.representative[seed], mirrorIndex = record.representative[mirror];
  const before = Float32Array.from(mesh.getVerticesData('position'));
  const localDelta = new Vector3(0.25, 0.1, 0);
  const worldDelta = Vector3.TransformNormal(localDelta, root.computeWorldMatrix(true));
  beginPointDrag(seed);
  cage.moveDrag(worldDelta);
  cage.endDrag();

  const after = mesh.getVerticesData('position');
  assert.ok(Math.abs(after[primaryIndex * 3] - before[primaryIndex * 3] - 0.25) < 1e-5, 'the grabbed side follows the drag');
  assert.ok(Math.abs(after[mirrorIndex * 3] - before[mirrorIndex * 3] + 0.25) < 1e-5, 'the opposite side mirrors X movement');
  assert.ok(Math.abs(after[primaryIndex * 3 + 1] - before[primaryIndex * 3 + 1] - 0.1) < 1e-5, 'the grabbed side follows Y movement');
  assert.ok(Math.abs(after[mirrorIndex * 3 + 1] - before[mirrorIndex * 3 + 1] - 0.1) < 1e-5, 'the opposite side keeps Y movement');
  assert.ok(history, 'the mirrored drag is recorded as one undo step');

  history.undo();
  assert.ok(before.every((value, i) => value === mesh.getVerticesData('position')[i]), 'undo restores both sides');
  history.redo();
  assert.ok(after.every((value, i) => value === mesh.getVerticesData('position')[i]), 'redo restores both sides');

  const fartherDistance = after[primaryIndex * 3] - after[mirrorIndex * 3];
  beginPointDrag(seed);
  cage.moveDrag(Vector3.TransformNormal(new Vector3(-0.5, 0, 0), root.computeWorldMatrix(true)));
  cage.endDrag();
  const closer = mesh.getVerticesData('position');
  assert.ok(closer[primaryIndex * 3] - closer[mirrorIndex * 3] < fartherDistance, 'dragging toward the plane brings the mirrored pair closer');

  const second = Array.from({ length: record.controlPositions.length / 3 }, (_, vertex) => vertex).find((vertex) =>
    vertex !== seed && record.controlPositions[vertex * 3] > 0
      && mirrorVertexX(record.controlPositions, vertex, 1e-4) !== null);
  assert.notEqual(second, undefined, 'a second mirrored cage point is available for additive selection');
  const secondMirror = mirrorVertexX(record.controlPositions, second, 1e-4);
  const secondIndex = record.representative[second], secondMirrorIndex = record.representative[secondMirror];

  editor.inputModifiers.shift = true;
  selectPoint(second, true);
  editor.inputModifiers.shift = false;
  const beforeGroup = Float32Array.from(mesh.getVerticesData('position'));
  cage.beginSelectedDrag(record, seed);
  cage.moveDrag(Vector3.TransformNormal(new Vector3(0.1, 0, 0), root.computeWorldMatrix(true)));
  cage.endDrag();
  const afterGroup = mesh.getVerticesData('position');
  for (const [index, sign] of [[primaryIndex, 1], [mirrorIndex, -1], [secondIndex, 1], [secondMirrorIndex, -1]]) {
    assert.ok(Math.abs(afterGroup[index * 3] - beforeGroup[index * 3] - 0.1 * sign) < 1e-5, 'Shift-selected points move together with X symmetry');
  }
  history.undo();
  assert.ok(beforeGroup.every((value, i) => value === mesh.getVerticesData('position')[i]), 'group undo restores all selected points');
  history.redo();

  editor.inputModifiers.shift = true;
  selectPoint(second, true);
  editor.inputModifiers.shift = false;
  const beforeSingle = Float32Array.from(mesh.getVerticesData('position'));
  cage.beginSelectedDrag(record, seed);
  cage.moveDrag(Vector3.TransformNormal(new Vector3(0.1, 0, 0), root.computeWorldMatrix(true)));
  cage.endDrag();
  const afterSingle = mesh.getVerticesData('position');
  assert.ok(Math.abs(afterSingle[primaryIndex * 3] - beforeSingle[primaryIndex * 3] - 0.1) < 1e-5, 'the remaining selected point moves');
  assert.ok(Math.abs(afterSingle[secondIndex * 3] - beforeSingle[secondIndex * 3]) < 1e-5, 'Shift can remove a point from the selection');
  console.log('SubD X symmetry, object-local plane, and combined undo/redo pass.');
} finally {
  cage.dispose();
  scene.dispose();
  engine.dispose();
}
