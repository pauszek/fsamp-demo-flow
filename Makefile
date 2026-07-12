SHELL := /bin/bash

INFRA_DIR ?= ../fsamp-infra
E2E_DIR ?= ../fsamp-infra/e2e
GATEWAY_DIR ?= ../fsamp-gateway
PROCESSOR_DIR ?= ../fsamp-processor
PROCESSOR_DOCKER_TARGET ?= production
APP_URL ?= http://127.0.0.1:3000
APP_PORT ?= 3000
LOCALSTACK_URL ?= http://localhost:4566
GATEWAY_HEALTH_URL ?= http://localhost:8080/actuator/health

.PHONY: help env setup check-docker check-token images localstack-fast services-fast stack-fast stack wait-fast wait health app parity demo demo-fast open logs logs-fast e2e stop-app stop-parity stop stop-fast reset clean-runs

help:
	@echo "FSAMP demo targets"
	@echo ""
	@echo "  make demo        Provision Terraform-managed LocalStack Pro parity and run the console"
	@echo "  make demo-fast   Start the fast compose fallback and run the console"
	@echo "  make stack-fast  Build local images and start LocalStack/gateway/processor compose"
	@echo "  make images      Build gateway and processor images from local repos"
	@echo "  make app         Run only the Next.js console"
	@echo "  make e2e         Run the existing FSAMP e2e test container"
	@echo "  make health      Check LocalStack and gateway health"
	@echo "  make logs        Tail LocalStack, gateway and processor logs"
	@echo "  make stop        Stop the console, parity stack and fast e2e stack"
	@echo "  make reset       Stop stack, remove volumes, free the Docker network and clear captured demo runs"
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

localstack-fast: check-docker check-token
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose up -d localstack

services-fast: check-docker check-token
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose up -d gateway processor

stack-fast: images localstack-fast services-fast wait-fast

stack: stack-fast

wait-fast:
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
	@set -a; [ -f .env.local ] && source .env.local; set +a; \
	curl -fsS "$${AWS_ENDPOINT_URL:-$(LOCALSTACK_URL)}/_localstack/health" >/dev/null && echo "LocalStack OK"; \
	if [ "$${FSAMP_DEMO_RUNTIME:-terraform-local}" = "terraform-local" ]; then \
		base="$${GATEWAY_URL:?GATEWAY_URL missing; run make demo or cd $(INFRA_DIR) && make local-parity}"; \
		path="$${GATEWAY_HEALTH_PATH:-/health}"; \
		curl -fsS "$${base%/}/$${path#/}" >/dev/null && echo "API Gateway OK"; \
		aws --endpoint-url "$${AWS_ENDPOINT_URL:-$(LOCALSTACK_URL)}" --region "$${AWS_REGION:-us-west-2}" lambda list-event-source-mappings >/dev/null && echo "Lambda mappings OK"; \
	else \
		curl -fsS "$(GATEWAY_HEALTH_URL)" >/dev/null && echo "Gateway OK"; \
		docker ps --filter name=fsamp-e2e-processor --filter health=healthy --format '{{.Names}}' | grep -q fsamp-e2e-processor && echo "Processor OK"; \
	fi

app: setup
	@APP_PORT="$(APP_PORT)" ./scripts/run-next-dev.sh

parity: check-docker check-token
	@set -a; source .env.local; set +a; \
	cd "$(INFRA_DIR)" && LOCALSTACK_AUTH_TOKEN="$${LOCALSTACK_AUTH_TOKEN}" \
		GATEWAY_DIR="$(CURDIR)/$(GATEWAY_DIR)" \
		PROCESSOR_DIR="$(CURDIR)/$(PROCESSOR_DIR)" \
		DEMO_ENV_PATH="$(CURDIR)/.env.local" \
		make local-parity

demo: setup
	@if $(MAKE) --no-print-directory health >/dev/null 2>&1; then \
		echo "Existing LocalStack parity stack is healthy; skipping Terraform apply."; \
	else \
		$(MAKE) --no-print-directory parity; \
	fi
	@APP_PORT="$(APP_PORT)" ./scripts/run-next-dev.sh

demo-fast: setup stack-fast
	@APP_PORT="$(APP_PORT)" ./scripts/run-next-dev.sh

open:
	@open "$(APP_URL)"

logs: check-docker
	@set -a; [ -f .env.local ] && source .env.local; set +a; \
	if [ "$${FSAMP_DEMO_RUNTIME:-terraform-local}" = "terraform-local" ]; then \
		aws --endpoint-url "$${AWS_ENDPOINT_URL:-$(LOCALSTACK_URL)}" --region "$${AWS_REGION:-us-west-2}" logs tail "/aws/lambda/$${OUTBOX_PUBLISHER_LAMBDA_NAME:-fsamp-local-outbox-publisher}" --follow; \
	else \
		$(MAKE) logs-fast; \
	fi

logs-fast: check-docker
	@cd "$(E2E_DIR)" && docker compose logs -f localstack gateway processor

e2e: stack-fast
	@set -a; source .env.local; set +a; \
	cd "$(E2E_DIR)" && docker compose --profile test up --build --abort-on-container-exit --exit-code-from e2e-tests e2e-tests

stop-fast: check-docker
	@cd "$(E2E_DIR)" && docker compose down --remove-orphans

stop-app:
	@screen -S fsamp-demo-flow -X quit >/dev/null 2>&1 || true
	@pids="$$(lsof -tiTCP:$(APP_PORT) -sTCP:LISTEN 2>/dev/null || true)"; \
	if [ -n "$$pids" ]; then \
		echo "Stopping process listening on port $(APP_PORT): $$pids"; \
		kill $$pids 2>/dev/null || true; \
		sleep 1; \
		pids="$$(lsof -tiTCP:$(APP_PORT) -sTCP:LISTEN 2>/dev/null || true)"; \
		[ -z "$$pids" ] || kill -9 $$pids 2>/dev/null || true; \
	else \
		echo "Port $(APP_PORT) is free"; \
	fi

stop-parity: check-docker
	@cd "$(INFRA_DIR)" && $(MAKE) local-parity-down

stop: stop-app stop-parity stop-fast

reset: check-docker stop-app
	@cd "$(INFRA_DIR)" && $(MAKE) local-parity-reset
	@cd "$(E2E_DIR)" && docker compose down -v --remove-orphans
	@rm -rf .demo-runs

clean-runs:
	@rm -rf .demo-runs
