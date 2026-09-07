"""Bake connected, display-only comparison meshes from the source GLBs.

The source assets are intentionally never overwritten. Textured sources are
converted to vertex colours before Open3D decimation because the resulting
display GLBs do not need to retain the original texture atlas; ?detail=full
continues to load the source asset for expert inspection.
"""

from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "cases" / "case_001" / "models"
DISPLAY_DIR = SOURCE_DIR / "display"
TARGET_TRIANGLES = 60_000
MODELS = ("agreement", "average", "entropy", "trellis2")


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    """Convert image samples to the linear values required by glTF COLOR_0."""
    return np.where(values <= 0.04045, values / 12.92,
                    ((values + 0.055) / 1.055) ** 2.4)


def bake_display(name: str) -> None:
    source_path = SOURCE_DIR / f"{name}.glb"
    display_path = DISPLAY_DIR / f"{name}.glb"
    source = trimesh.load(source_path, force="mesh", process=False)
    visual = source.visual.to_color() if hasattr(source.visual, "to_color") else source.visual

    mesh = o3d.geometry.TriangleMesh(
        vertices=o3d.utility.Vector3dVector(np.asarray(source.vertices, dtype=np.float64)),
        triangles=o3d.utility.Vector3iVector(np.asarray(source.faces, dtype=np.int32)),
    )
    colors = np.asarray(visual.vertex_colors[:, :3], dtype=np.float64) / 255.0
    # Texture image samples are sRGB; vertex-color sources are already the
    # authored values and must retain their existing byte encoding.
    if source.visual.kind == "texture":
        colors = srgb_to_linear(colors)
    mesh.vertex_colors = o3d.utility.Vector3dVector(colors)
    if source.visual.kind == "texture":
        # UV seams duplicate coincident vertices. Decimating disconnected
        # texture islands creates visible cracks; colors are already baked,
        # so weld the seams before reducing this display-only surface.
        mesh.merge_close_vertices(1e-6)
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
    display = mesh.simplify_quadric_decimation(TARGET_TRIANGLES)
    display.remove_degenerate_triangles()
    display.remove_duplicated_triangles()
    # Coincident seam junctions can leave a handful of overlapping faces.
    # Repair only this small non-manifold residue, never broadly filter faces.
    before_repair = len(display.triangles)
    display.remove_non_manifold_edges()
    if before_repair - len(display.triangles) > before_repair * 0.005:
        raise ValueError(f"{name}: excessive topology repair; inspect the source")
    display.remove_unreferenced_vertices()
    display.compute_vertex_normals()

    baked = trimesh.Trimesh(
        vertices=np.asarray(display.vertices),
        faces=np.asarray(display.triangles),
        vertex_colors=np.clip(np.asarray(display.vertex_colors) * 255.0, 0, 255).astype(np.uint8),
        process=False,
    )
    baked.vertex_normals = np.asarray(display.vertex_normals)
    baked.export(display_path, file_type="glb")
    print(f"{name}: {len(source.faces)} -> {len(baked.faces)} triangles; {display_path}")


def main() -> None:
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    for name in MODELS:
        bake_display(name)


if __name__ == "__main__":
    main()
