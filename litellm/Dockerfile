# LiteLLM 网关镜像：官方镜像 + 自定义身份注入 Hook
#
# Hook 必须在 PYTHONPATH 上，config.yaml 里用
#   callbacks: [trusted_identity_hook.trusted_identity_hook]
# 按模块名引用。
FROM ghcr.io/berriai/litellm:main-stable

WORKDIR /app
COPY trusted_identity_hook.py /app/trusted_identity_hook.py
COPY config.yaml /app/config.yaml

ENV PYTHONPATH=/app

EXPOSE 4000
ENTRYPOINT ["litellm"]
CMD ["--config", "/app/config.yaml", "--port", "4000", "--host", "0.0.0.0"]
