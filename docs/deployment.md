# Deployment and recovery

The hardened container is the recommended deployment boundary. Native mode is useful for local development, but a browser process is not a substitute for a container or VM when browsing adversarial sites.

## Initial deployment

1. Generate a 32-byte or longer bearer token and store it in the deployment secret manager.
2. Create a persistent volume for `/data`; keep `/tmp/tendril` ephemeral.
3. Bind the published port to loopback unless an authenticated TLS reverse proxy is in front of Tendril.
4. Give Chromium a private 1 GiB shared-memory allocation, a read-only root filesystem, the supplied seccomp profile, and explicit CPU, memory, and PID limits.
5. Keep the container non-root and retain only `SYS_CHROOT`, which Chromium's setuid sandbox requires.

```bash
docker volume create project-tendril-data

docker run --detach --restart unless-stopped \
  --name project-tendril \
  --publish 127.0.0.1:3210:3210 \
  --shm-size 1g \
  --memory 2g \
  --cpus 2 \
  --pids-limit 512 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --security-opt seccomp=seccomp_profile.json \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --env TENDRIL_TOKEN="replace-with-a-secret-manager-value" \
  --volume project-tendril-data:/data \
  ghcr.io/gadgethd/project-tendril:latest
```

Do not add `--ipc=host` or `--security-opt no-new-privileges`. The first weakens isolation; the second prevents Chromium's setuid sandbox from starting in this image.

## Readiness and smoke test

Check liveness, then make an authenticated session lifecycle request. Do not treat an HTTP-only health response as proof that Chromium is usable.

```bash
curl --fail --silent http://127.0.0.1:3210/health
curl --fail --silent \
  --header "Authorization: Bearer $TENDRIL_TOKEN" \
  http://127.0.0.1:3210/v1/sessions
```

Run `tendril doctor` in native installations. An explicit no-sandbox warning is a failed production readiness signal even when development mode is allowed.

## Upgrade and rollback

1. Back up named profiles while Tendril is stopped.
2. Pull the exact semantic-version image rather than `latest`.
3. Start the new image against the existing data volume and run authenticated create, content, snapshot, and close checks.
4. Keep the previous image digest until the new version has run successfully.
5. To roll back, stop the new container and restart the previous digest with the same configuration and data volume.

Never run two Tendril versions against the same `/data` volume at once. Named profiles are single-writer state.

## Token rotation

Set a new `TENDRIL_TOKEN` secret and restart the service. Existing HTTP, MCP, dashboard, and CDP clients must reconnect with the new token. When using the generated token file instead of an environment secret, stop Tendril, move `/data/http-token` to a protected backup, restart once to generate a replacement, and verify its mode is owner-only before discarding the backup.

## Profile backup and restore

Stop the service before copying `/data/profiles`. Preserve file modes and symlinks, encrypt backups, and test restore into a separate volume. Do not copy a normal desktop Chrome profile into Tendril or open one Tendril profile from two runtimes.

## Crash recovery

After a crash, first confirm that no Tendril Chromium process still references the runtime directory. Ephemeral state lives below `/tmp/tendril`; named profiles live below `/data/profiles` and must not be deleted during cleanup. Restart the supervised service, inspect logs for failed cleanup, and run the authenticated smoke test. Repeated browser launch failures should stop the rollout rather than trigger profile deletion or no-sandbox fallback.
