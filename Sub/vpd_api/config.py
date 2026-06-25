from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # API port
    HOST: str
    PORT: int

    # AI model configuration
    YOLO_DET_WEIGHTS_PATH: str
    YOLO_SEG_WEIGHTS_PATH: str
    YOLO_CONF_THRESHOLD: float
    YOLO_IOU_THRESHOLD: float
    # get normal environment variables
    model_config = SettingsConfigDict(env_file="./.env")


settings = Settings()
