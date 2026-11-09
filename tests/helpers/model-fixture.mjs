export function modelFixture(extra = {}) {
  const positions = new Float32Array([
    -0.5, -1, 0.5, 0.5, -1, 0.5, 0.5, 1, 0.5, -0.5, -1, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, -1,
    -0.5, -0.5, -1, -0.5, -0.5, 1, -0.5, 0.5, -1, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, -1, -0.5,
    -0.5, -1, 0.5, -0.5, 1, 0.5, -0.5, -1, -0.5, -0.5, 1, 0.5, -0.5, 1, -0.5, 0.5, -1, 0.5, 0.5, -1,
    -0.5, 0.5, 1, -0.5, 0.5, -1, 0.5, 0.5, 1, -0.5, 0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, 0.5, 0.5, 1,
    -0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5, -0.5, -1, -0.5, 0.5, -1, -0.5, 0.5, -1, 0.5,
    -0.5, -1, -0.5, 0.5, -1, 0.5, -0.5, -1, 0.5,
  ]);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.15, 0.45, 0.8, 1],
          metallicFactor: 0,
          roughnessFactor: 0.7,
        },
      },
    ],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 36,
        type: 'VEC3',
        min: [-0.5, -1, -0.5],
        max: [0.5, 1, 0.5],
      },
    ],
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(json);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + positions.byteLength, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(positions.byteLength, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, binaryHeader, Buffer.from(positions.buffer)]);
}
