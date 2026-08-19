/** Desktop package workflow policy for Windows and Android artifacts. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const WORKFLOW_PATH = '.github/workflows/desktop-portable.yml'

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stepsOf(job: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(job.steps)) throw new TypeError('job must define steps')
  return job.steps.filter(isRecord)
}

function hasRun(step: Record<string, unknown>, fragment: string): boolean {
  return typeof step.run === 'string' && step.run.includes(fragment)
}

/** The `with` block of an actions step, or an empty record when absent. */
function stepWith(step: Record<string, unknown>): Record<string, unknown> {
  return isRecord(step.with) ? step.with : {}
}

/** The `portable` job, asserted present and shaped. */
function portableJob(workflow: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.portable)) {
    throw new TypeError('workflow must define the portable job')
  }
  return workflow.jobs.portable
}

function androidJob(workflow: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.android)) {
    throw new TypeError('workflow must define the android job')
  }
  return workflow.jobs.android
}

describe('Desktop portable workflow', () => {
  it('runs the packaged acceptance on a native Windows 2025 runner', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.portable)) {
      throw new TypeError('workflow must define the portable job')
    }
    const job = workflow.jobs.portable
    expect(job['runs-on']).toBe('windows-2025')
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(60)
  })

  it('installs the dependency graph immutably', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    expect(steps.some(step => hasRun(step, 'pnpm install --frozen-lockfile'))).toBe(true)
  })

  it('pins a fixed SOURCE_DATE_EPOCH so release archives are deterministic', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const env = workflow.env
    if (!isRecord(env) || typeof env.SOURCE_DATE_EPOCH !== 'string' || env.SOURCE_DATE_EPOCH.length === 0) {
      throw new TypeError('workflow must set a fixed SOURCE_DATE_EPOCH env')
    }
    const epoch = Number(env.SOURCE_DATE_EPOCH)
    expect(Number.isInteger(epoch)).toBe(true)
    expect(epoch).toBeGreaterThanOrEqual(0)
  })

  it('builds the portable archive with the deterministic builder', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    expect(steps.some(step => hasRun(step, 'pnpm run desktop:build'))).toBe(true)
  })

  it('runs the packaged smoke after artifact assembly', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    const smokeIndex = steps.findIndex(step => hasRun(step, 'scripts/smoke-desktop-portable.ps1'))
    const buildIndex = steps.findIndex(step => hasRun(step, 'pnpm run desktop:build'))
    expect(smokeIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(smokeIndex).toBeGreaterThan(buildIndex)
  })

  it('verifies the SHA-256 checksum file before the smoke', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    const shaIndex = steps.findIndex(step => hasRun(step, '.sha256'))
    const smokeIndex = steps.findIndex(step => hasRun(step, 'scripts/smoke-desktop-portable.ps1'))
    expect(shaIndex).toBeGreaterThan(-1)
    expect(shaIndex).toBeLessThan(smokeIndex)
  })

  it('uploads the ZIP, checksum, and smoke metadata', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    const uploads = steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    expect(uploads.length).toBeGreaterThan(0)
    for (const upload of uploads) {
      const path = stepWith(upload)['path']
      expect(typeof path).toBe('string')
      expect(String(path)).toMatch(/\.zip/)
      expect(String(path)).toMatch(/\.sha256/)
    }
  })

  it('retains PR uploads for seven days and release uploads indefinitely', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = portableJob(workflow)
    const steps = stepsOf(job)
    const upload = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    expect(upload).toBeDefined()
    const retention = stepWith(upload!)['retention-days']
    expect(typeof retention).toBe('string')
    expect(String(retention)).toContain('7')
  })

  it('builds ARM64 Android APK and AAB for pull requests and manual package runs', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = androidJob(workflow)
    const steps = stepsOf(job)
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'")
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(steps.some(step => hasRun(step, "'ndk;27.0.12077973'"))).toBe(true)
    expect(steps.some(step => hasRun(step, 'pnpm run desktop:android:init -- --ci --skip-targets-install'))).toBe(true)
    expect(steps.some(step => hasRun(step, 'pnpm run desktop:android:build -- --apk --aab --target aarch64'))).toBe(true)
  })

  it('uploads only Android install artifacts from the manual package job', () => {
    const workflow = loadWorkflow(WORKFLOW_PATH)
    const job = androidJob(workflow)
    const upload = stepsOf(job).find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    expect(upload).toBeDefined()
    const path = String(stepWith(upload!)['path'])
    expect(path).toMatch(/\.apk/)
    expect(path).toMatch(/\.aab/)
    expect(stepWith(upload!)['retention-days']).toBe(7)
  })
})
