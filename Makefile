SHELL := /bin/bash
PNPM := corepack pnpm

.PHONY: bootstrap setup dev dev-api dev-web compose-up compose-down test-compose record-demo lint typecheck test-unit test-contract test-integration test-e2e test-infra test-security synth-infra build build-web migrate-postgres seed-traveler-data deploy evidence

bootstrap:
	corepack pnpm --version
	$(PNPM) install --frozen-lockfile

setup: bootstrap
	@test -f .env.local || cp .env.example .env.local
	@echo "Local fixture configuration ready. No live provider or AWS resources were started."

dev:
	$(PNPM) dev

dev-api:
	$(PNPM) dev:api

dev-web:
	$(PNPM) dev:web

compose-up:
	docker compose up --build

compose-down:
	docker compose down

test-compose:
	$(PNPM) test:compose

record-demo:
	$(PNPM) record:demo

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

test-unit:
	$(PNPM) test:unit

test-contract:
	$(PNPM) test:contract

test-security:
	$(PNPM) test:security

build:
	$(PNPM) build

build-web:
	$(PNPM) build:web

migrate-postgres:
	$(PNPM) migrate:postgres

seed-traveler-data:
	$(PNPM) seed:traveler-data

test-integration:
	$(PNPM) test:integration

test-e2e:
	$(PNPM) test:e2e

test-infra:
	$(PNPM) typecheck:infra
	$(PNPM) test:infra
	$(PNPM) synth:infra

synth-infra:
	$(PNPM) synth:infra

deploy:
	@echo "BLOCKED: deployment is unavailable until infrastructure and live preflight exist." >&2
	@exit 1

evidence:
	@echo "Foundation only: no live integration, device, accessibility, or release evidence. See docs/validation.md."
