SHELL := /bin/bash

E2E_DIR ?= ../fsamp-infra/e2e
GATEWAY_DIR ?= ../fsamp-gateway
PROCESSOR_DIR ?= ../fsamp-processor
PROCESSOR_DOCKER_TARGET ?= production
APP_URL ?= http://localhost:3000
LOCALSTACK_URL ?= http://localhost:4566
GATEWAY_HEALTH_URL ?= http://localhost:8080/actuator/health

.PHONY: help env setup check-docker check-token images localstack services stack wait health app demo open logs e2e stop reset clean-runs

help:
	@echo "FSAMP demo targets"
	@echo ""
	@echo "  make demo        Start LocalStack stack and run the Next.js console"
	@echo "  make stack       Build local images and start LocalStack/gateway/processor"
	@echo "  make images      Build gateway and processor images from local repos"
	@echo "  make app         Run only the Next.js console"
	@echo "  make e2e         Run the existing FSAMP e2e test container"
	@echo "  make health      Check LocalStack and gateway health"
	@echo "  make logs        Tail LocalStack, gateway and processor logs"
	@echo "  make stop        Stop the Docker e2e stack"
	@echo "  make reset       Stop stack, remove volumes and clear captured demo runs"
	@echo ""
	@echo "Set LOCALSTACK_AUTH_TOKEN in .env.local before starting the stack."

env:
	@if [ ! -f .env.local ]; then cp .env.example .env.local; fi
	@echo ".env.local is ready"

setup: env
	@if [ ! -d node_modules ]; then npm install; else echo "node_modules already present"; fi

check-docker:
	@docker info >/dev/null 2>&1 || (echo "Docker is not running. Start Docker Desktop first." && exit 1)

check-token: env
	@set -a; source .env.local; set +a; \
	if [ -z "$${LOCALSTACK_AUTH_TOKEN:-}" ]; then \
		echo "LOCALSTACK_AUTH_TOKEN is empty in .env.local"; \
		echo "Fill it before running LocalStack Pro."; \
		exit 1; \
	fi

images: check-docker env
	@set -a; source .env.local; set +a; \
	echo "Building gateway image: $${GATEWAY_IMAGE:-fsamp-gateway:local}"; \
	docker build -t "$${GATEWAY_IMAGE:-fsamp-gateway:local}" "$(GATEWAY_DIR)"; \
	echo "Building processor image: $${PROCESSOR_IMAGE:-fsamp-processor:local}"; \
	docker build --target "$(PROCESSOR_DOCKER_TARGET)" --build-arg REQUIRE_FIPS_PROVIDER=false -t "$${PROCESSOR_IMAGE:-fsamp-processor:local}" "$(PROCESSOR_DIR)"

localstack: check-docker check-token
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose up -d localstack

services: check-docker check-token
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose up -d gateway processor

stack: images localstack services wait

wait:
	@set -euo pipefail; \
	echo "Waiting for LocalStack..."; \
	for i in {1..90}; do \
		if curl -fsS "$(LOCALSTACK_URL)/_localstack/health" >/dev/null; then break; fi; \
		if [ "$$i" -eq 90 ]; then echo "LocalStack did not become healthy"; exit 1; fi; \
		sleep 2; \
	done; \
	echo "Waiting for gateway..."; \
	for i in {1..90}; do \
		if curl -fsS "$(GATEWAY_HEALTH_URL)" >/dev/null; then break; fi; \
		if [ "$$i" -eq 90 ]; then echo "Gateway did not become healthy"; exit 1; fi; \
		sleep 2; \
	done; \
	echo "Waiting for processor..."; \
	for i in {1..90}; do \
		if docker ps --filter name=fsamp-e2e-processor --filter health=healthy --format '{{.Names}}' | grep -q fsamp-e2e-processor; then break; fi; \
		if [ "$$i" -eq 90 ]; then echo "Processor did not become healthy"; exit 1; fi; \
		sleep 2; \
	done; \
	echo "FSAMP e2e stack is ready"

health:
	@curl -fsS "$(LOCALSTACK_URL)/_localstack/health" >/dev/null && echo "LocalStack OK"
	@curl -fsS "$(GATEWAY_HEALTH_URL)" >/dev/null && echo "Gateway OK"
	@docker ps --filter name=fsamp-e2e-processor --filter health=healthy --format '{{.Names}}' | grep -q fsamp-e2e-processor && echo "Processor OK"

app: setup
	@npm run dev

demo: setup stack
	@npm run dev

open:
	@open "$(APP_URL)"

logs: check-docker
	@cd "$(E2E_DIR)" && docker compose logs -f localstack gateway processor

e2e: stack
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose --profile test up --build --abort-on-container-exit --exit-code-from e2e-tests e2e-tests

stop: check-docker
	@cd "$(E2E_DIR)" && docker compose down

reset: check-docker
	@cd "$(E2E_DIR)" && docker compose down -v
	@rm -rf .demo-runs

clean-runs:
	@rm -rf .demo-runs
