"""Run the shared 13 real-pixel workload on this ticket's reserved port."""
from pathlib import Path
import runpy
from unittest.mock import patch
import uvicorn

run = uvicorn.run
with patch.object(uvicorn, "run", lambda app, **options: run(app, **{**options, "port": 43150})):
    runpy.run_path(str(Path(__file__).with_name("13-browser-server.py")), run_name="__main__")
