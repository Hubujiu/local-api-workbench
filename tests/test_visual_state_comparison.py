import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

spec = importlib.util.spec_from_file_location("visual_compare", Path(__file__).parents[1] / "scripts/compare-visual-states.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PixelEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        Image.new("RGB", (8, 6), "white").save(self.root / "a.png")
        Image.new("RGB", (8, 6), "white").save(self.root / "b.png")
        state = {"page": "http", "theme": "light", "fixtureDigest": "a" * 64, "viewport": [8, 6],
                 "deviceScaleFactor": 1, "locale": "zh-CN", "zoom": 1, "scroll": [0, 0], "selection": "params", "responseState": "empty"}
        def entry(file, product):
            return {"file": file, "product": product, "version": "synthetic", "capturedAt": "test-only",
                    "inspected": True, "state": dict(state)}
        self.data = {"version": 1, "pairs": [{"id": "http-light", "reference": entry("a.png", "reference"), "workbench": entry("b.png", "workbench")}]}

    def run_report(self):
        (self.root / "input.json").write_text(json.dumps(self.data))
        return module.build_report(self.root / "input.json", self.root / "result")

    def test_exact_and_no_overwrite(self):
        result = self.run_report()
        self.assertEqual(result["status"], "exact")
        self.assertEqual(result["pairs"][0]["changedPixels"], 0)
        with self.assertRaises(FileExistsError):
            self.run_report()

    def test_single_pixel_is_not_tolerated(self):
        image = Image.open(self.root / "b.png")
        image.putpixel((3, 2), (254, 255, 255))
        image.save(self.root / "b.png")
        result = self.run_report()["pairs"][0]
        self.assertEqual(result["status"], "different")
        self.assertEqual(result["changedPixels"], 1)
        self.assertEqual(result["changedBounds"], (3, 2, 4, 3))
        self.assertEqual(result["maxChannelError"], 1)

    def test_missing_reference_is_blocked(self):
        self.data["pairs"][0]["reference"] = None
        self.assertEqual(self.run_report()["status"], "blocked")

    def test_wrong_state_is_not_compared(self):
        self.data["pairs"][0]["workbench"]["state"]["responseState"] = "success"
        self.assertEqual(self.run_report()["status"], "blocked")

    def test_wrong_dimensions_never_resized(self):
        Image.new("RGB", (9, 6), "white").save(self.root / "b.png")
        self.assertEqual(self.run_report()["status"], "blocked")

    def test_uninspected_evidence_is_blocked(self):
        self.data["pairs"][0]["reference"]["inspected"] = False
        self.assertEqual(self.run_report()["status"], "blocked")

    def test_explicit_crop_recorded(self):
        for key in ("reference", "workbench"):
            self.data["pairs"][0][key]["contentCrop"] = [1, 1, 7, 5]
        result = self.run_report()["pairs"][0]
        self.assertEqual(result["status"], "exact")
        self.assertEqual(result["reference"]["comparedSize"], [6, 4])
        self.assertEqual(result["reference"]["contentCrop"], [1, 1, 7, 5])

    def test_path_traversal_in_output_id_rejected(self):
        self.data["pairs"][0]["id"] = "../escape"
        with self.assertRaises(ValueError):
            self.run_report()


if __name__ == "__main__":
    unittest.main()
