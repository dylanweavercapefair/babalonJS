export interface PolyFace {
  vertices: number[];
  material: number;
  uv: number[] | null;
}

export interface CageMeshData {
  positions: Float32Array;
  faces: PolyFace[];
}

export function edgeKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function mirrorVertexX(positions: Float32Array, vertex: number, tolerance: number): number | null {
  const at = vertex * 3, x = positions[at];
  if (Math.abs(x) <= tolerance) return vertex;
  const targetX = -x, targetY = positions[at + 1], targetZ = positions[at + 2], limit = tolerance * tolerance;
  let best = -1, bestDistance = limit;
  for (let candidate = 0; candidate < positions.length / 3; candidate++) {
    if (candidate === vertex) continue;
    const offset = candidate * 3, dx = positions[offset] - targetX;
    const dy = positions[offset + 1] - targetY, dz = positions[offset + 2] - targetZ;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best < 0 ? null : best;
}

export function catmullClark(input: CageMeshData): CageMeshData {
  const edgeIndex = new Map<string, number>(), edges: { a: number; b: number; faces: number[] }[] = [];
  const faceEdges: number[][] = [], vertexFaces = Array.from({ length: input.positions.length / 3 }, () => [] as number[]);
  for (let f = 0; f < input.faces.length; f++) {
    const vertices = input.faces[f].vertices, list: number[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length], key = edgeKey(a, b);
      let index = edgeIndex.get(key);
      if (index === undefined) {
        index = edges.length; edgeIndex.set(key, index); edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      }
      edges[index].faces.push(f);
      list.push(index);
      vertexFaces[a].push(f);
    }
    faceEdges.push(list);
  }
  const vertexEdges = Array.from({ length: vertexFaces.length }, () => [] as number[]);
  const boundaryNeighbors = Array.from({ length: vertexFaces.length }, () => new Set<number>());
  edges.forEach((edge, i) => {
    vertexEdges[edge.a].push(i); vertexEdges[edge.b].push(i);
    if (edge.faces.length !== 2) {
      boundaryNeighbors[edge.a].add(edge.b);
      boundaryNeighbors[edge.b].add(edge.a);
    }
  });
  const oldCount = input.positions.length / 3, faceOffset = oldCount + edges.length;
  const positions = new Float32Array((faceOffset + input.faces.length) * 3);
  const facePoints = new Float32Array(input.faces.length * 3);
  for (let f = 0; f < input.faces.length; f++) {
    const vertices = input.faces[f].vertices, at = f * 3;
    for (const v of vertices) for (let c = 0; c < 3; c++) facePoints[at + c] += input.positions[v * 3 + c] / vertices.length;
    positions.set(facePoints.subarray(at, at + 3), (faceOffset + f) * 3);
  }
  for (let e = 0; e < edges.length; e++) {
    const { a, b, faces: around } = edges[e], at = (oldCount + e) * 3;
    for (let c = 0; c < 3; c++) {
      const p = input.positions[a * 3 + c], q = input.positions[b * 3 + c];
      positions[at + c] = around.length === 2
        ? (p + q + facePoints[around[0] * 3 + c] + facePoints[around[1] * 3 + c]) * 0.25
        : (p + q) * 0.5;
    }
  }
  for (let v = 0; v < oldCount; v++) {
    const at = v * 3, boundary = [...boundaryNeighbors[v]];
    if (boundary.length === 2) {
      for (let c = 0; c < 3; c++) positions[at + c] = (6 * input.positions[at + c] + input.positions[boundary[0] * 3 + c] + input.positions[boundary[1] * 3 + c]) / 8;
    } else if (boundary.length) {
      positions.set(input.positions.subarray(at, at + 3), at);
    } else {
      const incidentEdges = vertexEdges[v], incidentFaces = vertexFaces[v], n = incidentEdges.length;
      if (!n || !incidentFaces.length) { positions.set(input.positions.subarray(at, at + 3), at); continue; }
      for (let c = 0; c < 3; c++) {
        let faceAverage = 0, edgeAverage = 0;
        for (const f of incidentFaces) faceAverage += facePoints[f * 3 + c] / incidentFaces.length;
        for (const e of incidentEdges) {
          const edge = edges[e];
          edgeAverage += (input.positions[edge.a * 3 + c] + input.positions[edge.b * 3 + c]) / (2 * n);
        }
        positions[at + c] = (faceAverage + 2 * edgeAverage + (n - 3) * input.positions[at + c]) / n;
      }
    }
  }

  const faces: PolyFace[] = [];
  for (let f = 0; f < input.faces.length; f++) {
    const old = input.faces[f], count = old.vertices.length;
    let faceUV: number[] | null = null;
    if (old.uv) {
      faceUV = [0, 0];
      for (let i = 0; i < count; i++) { faceUV[0] += old.uv[i * 2] / count; faceUV[1] += old.uv[i * 2 + 1] / count; }
    }
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count, previous = (i + count - 1) % count;
      let uv: number[] | null = null;
      if (old.uv && faceUV) {
        const midNext = [(old.uv[i * 2] + old.uv[next * 2]) / 2, (old.uv[i * 2 + 1] + old.uv[next * 2 + 1]) / 2];
        const midPrevious = [(old.uv[i * 2] + old.uv[previous * 2]) / 2, (old.uv[i * 2 + 1] + old.uv[previous * 2 + 1]) / 2];
        uv = [...old.uv.slice(i * 2, i * 2 + 2), ...midNext, ...faceUV, ...midPrevious];
      }
      faces.push({
        vertices: [old.vertices[i], oldCount + faceEdges[f][i], faceOffset + f, oldCount + faceEdges[f][previous]],
        material: old.material, uv,
      });
    }
  }
  return { positions, faces };
}
