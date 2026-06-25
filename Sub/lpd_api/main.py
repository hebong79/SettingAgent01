import logfire
from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from uvicorn import Config, Server

from config import settings
from routers import yolo

logfire.configure(service_name="lpd-obb-api")

app = FastAPI(
    title="LPD OBB API",
    description="API for LPD Oriented Bounding Box",
    version="0.1.0",
)
logfire.instrument_fastapi(app)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(yolo.router)

if __name__ == "__main__":
    server = Server(
        Config(
            app=app,
            host=settings.HOST,
            port=settings.PORT,
            lifespan="on",
        )
    )
    server.run()
