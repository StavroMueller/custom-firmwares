"""Run the booth: python -m booth [--host 0.0.0.0] [--port 8000]"""

import argparse

import uvicorn

from .app import create_app

parser = argparse.ArgumentParser(description="V500 scan booth")
parser.add_argument("--host", default="0.0.0.0")
parser.add_argument("--port", type=int, default=8000)
args = parser.parse_args()

uvicorn.run(create_app(), host=args.host, port=args.port)
