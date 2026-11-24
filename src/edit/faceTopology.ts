import { weld } from '../rigging/skinMath';

/**
 * Face connectivity of a mesh in compact arrays (built once per geometry, no string keys):
 * `offsets/list` give the faces sharing an edge with each face; vertices are welded by position
 * so UV seams don't split a surface.
 */
export interface FaceTopology {
  offsets: Uint32Array;
  list: Uint32Array;
  /** Vertex → welded vertex id. */
  weld: Uint32Array;
  /** Welded vertex → faces using it (`vertexFaces[vertexStart[v] .. vertexStart[v + 1]]`). */
  vertexStart: Uint32Array;
  vertexFaces: Uint32Array;
}

/** Smooth falloff by shortest distance along connected mesh edges from welded source vertices. */
export function topologyWeights(topology: FaceTopology, indices: ArrayLike<number>, positions: Float32Array, seeds: Iterable<number>, radius: number, scale = 1) {
  const groups = topology.vertexStart.length - 1;
  const distance = new Float32Array(groups).fill(Infinity);
  const heap = new MinHeap(groups);
  for (const seed of seeds) if (seed >= 0 && seed < groups && distance[seed] !== 0) {
    distance[seed] = 0;
    heap.push(seed, 0);
  }
  const representative = new Int32Array(groups).fill(-1);
  for (let v = 0; v < topology.weld.length; v++) if (representative[topology.weld[v]] < 0) representative[topology.weld[v]] = v;
  const done = new Uint8Array(groups);
  while (heap.size) {
    const a = heap.pop();
    if (done[a]) continue;
    done[a] = 1;
    if (distance[a] >= radius) continue;
    const pa = representative[a] * 3, da = distance[a];
    for (let k = topology.vertexStart[a]; k < topology.vertexStart[a + 1]; k++) {
      const face = topology.vertexFaces[k];
      for (let j = 0; j < 3; j++) {
        const b = topology.weld[indices[face * 3 + j]];
        if (b === a || done[b]) continue;
        const pb = representative[b] * 3;
        const next = da + Math.hypot(positions[pb] - positions[pa], positions[pb + 1] - positions[pa + 1], positions[pb + 2] - positions[pa + 2]) * scale;
        if (next < radius && next < distance[b]) {
          distance[b] = next;
          heap.push(b, next);
        }
      }
    }
  }
  const weights = new Float32Array(topology.weld.length);
  for (let v = 0; v < weights.length; v++) {
    const d = distance[topology.weld[v]];
    if (d !== Infinity) {
      const t = d === 0 ? 1 : radius > 0 ? Math.max(0, 1 - d / radius) : 0;
      weights[v] = t * t * (3 - 2 * t);
    }
  }
  return weights;
}

/** Pure version (also run in a worker, see topology.worker.ts). */
export function computeTopology(positions: Float32Array, indices: ArrayLike<number>): FaceTopology {
  const faces = indices.length / 3;
  const { map, points } = weld(positions);
  const vertices = points.length / 3;
  // Vertex → faces (CSR)
  const vStart = new Uint32Array(vertices + 1);
  for (let i = 0; i < indices.length; i++) vStart[map[indices[i]] + 1]++;
  for (let v = 0; v < vertices; v++) vStart[v + 1] += vStart[v];
  const vFaces = new Uint32Array(indices.length), fill = vStart.slice(0, vertices);
  for (let i = 0; i < indices.length; i++) vFaces[fill[map[indices[i]]]++] = (i / 3) | 0;
  // Face → faces sharing an edge: for edge (a, b), faces around a that also touch b
  const count = new Uint32Array(faces + 1);
  const scratch: number[] = [];
  const edgeNeighbors = (f: number, out: number[]) => {
    out.length = 0;
    for (let e = 0; e < 3; e++) {
      const a = map[indices[f * 3 + e]], b = map[indices[f * 3 + (e + 1) % 3]];
      if (a === b) continue;
      for (let k = vStart[a]; k < vStart[a + 1]; k++) {
        const g = vFaces[k];
        if (g === f) continue;
        const ga = map[indices[g * 3]], gb = map[indices[g * 3 + 1]], gc = map[indices[g * 3 + 2]];
        if (ga === b || gb === b || gc === b) out.push(g);
      }
    }
    return out;
  };
  for (let f = 0; f < faces; f++) count[f + 1] = edgeNeighbors(f, scratch).length;
  for (let f = 0; f < faces; f++) count[f + 1] += count[f];
  const list = new Uint32Array(count[faces]);
  for (let f = 0; f < faces; f++) list.set(edgeNeighbors(f, scratch), count[f]);
  return { offsets: count, list, weld: map, vertexStart: vStart, vertexFaces: vFaces };
}

class MinHeap {
  private items: Uint32Array;
  private keys: Float32Array;
  size = 0;
  constructor(capacity: number) { this.items = new Uint32Array(Math.max(16, capacity)); this.keys = new Float32Array(this.items.length); }
  push(item: number, key: number) {
    if (this.size === this.items.length) {
      const items = new Uint32Array(this.size * 2), keys = new Float32Array(this.size * 2);
      items.set(this.items); keys.set(this.keys); this.items = items; this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.items[i] = this.items[parent]; this.keys[i] = this.keys[parent]; i = parent;
    }
    this.items[i] = item; this.keys[i] = key;
  }
  pop() {
    const top = this.items[0], lastItem = this.items[--this.size], lastKey = this.keys[this.size];
    let i = 0;
    while (true) {
      let child = i * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= lastKey) break;
      this.items[i] = this.items[child]; this.keys[i] = this.keys[child]; i = child;
    }
    this.items[i] = lastItem; this.keys[i] = lastKey;
    return top;
  }
}

/**
 * Faces along open edges, and a test saying whether edge `j` (vertices j, j+1) of a face is open
 * (no other face shares it), from the connectivity: for local work on large meshes.
 */
export function openEdges(t: FaceTopology, indices: ArrayLike<number>) {
  const open = (f: number, j: number) => {
    const a = t.weld[indices[f * 3 + j]], b = t.weld[indices[f * 3 + (j + 1) % 3]];
    for (let k = t.offsets[f]; k < t.offsets[f + 1]; k++) {
      const g = t.list[k], x = t.weld[indices[g * 3]], y = t.weld[indices[g * 3 + 1]], z = t.weld[indices[g * 3 + 2]];
      // Degenerate faces (two corners at one point) don't close an edge, as in the border search
      if (x === y || y === z || x === z) continue;
      if ((x === a || y === a || z === a) && (x === b || y === b || z === b)) return false;
    }
    return true;
  };
  const faces: number[] = [];
  for (let f = 0; f < t.offsets.length - 1; f++) if (t.offsets[f + 1] - t.offsets[f] < 3 || open(f, 0) || open(f, 1) || open(f, 2)) faces.push(f);
  return { faces, open };
}
