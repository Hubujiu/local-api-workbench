// Offline standard-library regression only: no Docker/package/application imports,
// subprocesses, sockets, network, image access, or file writes. Reads bounded JSON
// from stdin, executes real text/template over synthetic typed fixtures, and emits
// synthetic results. Parent must audit before compiling/running with downloads off.
// Selected API field shapes/tags are mirrored from the official v28.5.1 sources:
// https://github.com/moby/moby/blob/v28.5.1/api/types/container/container.go
// https://github.com/moby/moby/blob/v28.5.1/api/types/container/hostconfig.go
// https://github.com/moby/moby/blob/v28.5.1/api/types/container/config.go
// https://github.com/moby/moby/blob/v28.5.1/api/types/image/image_inspect.go
// https://github.com/moby/moby/blob/v28.5.1/api/types/mount/mount.go
// Template helper behavior / typed-then-raw fallback:
// https://github.com/docker/cli/blob/v28.5.1/templates/templates.go
// https://github.com/docker/cli/blob/v28.5.1/cli/command/inspect/inspector.go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "os"
    "strings"
    "text/template"
)

type Input struct {
    ImageFormat, ContainerFormat, CleanupFormat string
    ClearKeys []string
    LabelKey, UID, RepoDigest string
}
type Config struct {
    User, WorkingDir string
    Env, Cmd, Entrypoint []string
    Healthcheck *HealthConfig `json:",omitempty"`
    Labels map[string]string
    Volumes map[string]struct{}
}
type HealthConfig struct { Test []string `json:",omitempty"` }
type Resources struct {
    Memory, MemorySwap int64
    NanoCPUs int64 `json:"NanoCpus"`
    PidsLimit *int64
    Devices []DeviceMapping
    DeviceRequests []DeviceRequest
    Ulimits []*Ulimit
}
type DeviceMapping struct { PathOnHost, PathInContainer, CgroupPermissions string }
type DeviceRequest struct { Driver string }
type Ulimit struct { Name string; Soft, Hard int64 }
type RestartPolicy struct { Name string; MaximumRetryCount int }
type LogConfig struct { Type string; Config map[string]string }
type HostConfig struct {
    Resources
    RestartPolicy RestartPolicy
    ReadonlyRootfs, Privileged, PublishAllPorts bool
    NetworkMode, IpcMode, PidMode, UTSMode, UsernsMode string
    CapAdd, CapDrop, SecurityOpt, Binds, VolumesFrom []string
    PortBindings map[string][]PortBinding
    LogConfig LogConfig
    Mounts []Mount `json:",omitempty"`
}
type PortBinding struct { HostIP, HostPort string }
type Mount struct {
    Type string `json:",omitempty"`
    Source, Target string `json:",omitempty"`
    ReadOnly bool `json:",omitempty"`
    BindOptions *struct{} `json:",omitempty"`
    TmpfsOptions *struct{} `json:",omitempty"`
    VolumeOptions *VolumeOptions `json:",omitempty"`
}
type VolumeOptions struct {
    NoCopy bool `json:",omitempty"`
    Labels map[string]string `json:",omitempty"`
    Subpath string `json:",omitempty"`
    DriverConfig *Driver `json:",omitempty"`
}
type Driver struct { Name string `json:",omitempty"`; Options map[string]string `json:",omitempty"` }
type MountPoint struct {
    Type, Name string `json:",omitempty"`
    Source, Destination string
    Driver string `json:",omitempty"`
    RW bool
}
type State struct { Running, OOMKilled bool; Status string; ExitCode int }
type NetworkSettings struct { Networks map[string]*EndpointSettings }
type EndpointSettings struct { NetworkID string }
type ContainerJSONBase struct {
    ID string `json:"Id"`
    Image, Path string
    Args []string
    HostConfig *HostConfig
    State *State
}
type ContainerInspectResponse struct {
    *ContainerJSONBase
    Mounts []MountPoint
    Config *Config
    NetworkSettings *NetworkSettings
}
type ImageInspectResponse struct {
    ID string `json:"Id"`
    RepoDigests []string
    Os, Architecture string
    Config *Config
    Size int64
}
type RenderedContainer struct {
    Inspection map[string]any `json:"inspection"`
    Cleanup map[string]any `json:"cleanup"`
    Volumes []string `json:"volumes"`
}
type RenderedImage struct { Inspection map[string]any `json:"inspection"`; Volumes []string `json:"volumes"` }
type Result struct {
    Passed int `json:"passed"`
    Failed int `json:"failed"`
    Cases []string `json:"cases"`
    Containers []RenderedContainer `json:"containers"`
    Images []RenderedImage `json:"images"`
}

var result Result

func check(name string, condition bool) {
    if !condition { fmt.Fprintln(os.Stderr, "FAIL: " + name); os.Exit(1) }
    result.Cases = append(result.Cases, name)
    result.Passed++
}

// Same observable json/split behavior as Docker's v28.5.1 template helpers.
func functions() template.FuncMap {
    return template.FuncMap{
        "json": func(value any) (string, error) {
            var buffer bytes.Buffer
            encoder := json.NewEncoder(&buffer)
            encoder.SetEscapeHTML(false)
            if err := encoder.Encode(value); err != nil { return "", err }
            return strings.TrimSpace(buffer.String()), nil
        },
        "split": strings.Split,
    }
}

func render(format string, value any, strict bool) ([]byte, error) {
    parsed, err := template.New("synthetic").Funcs(functions()).Parse(format)
    if err != nil { return nil, err }
    if strict { parsed = parsed.Option("missingkey=error") }
    var output bytes.Buffer
    err = parsed.Execute(&output, value)
    return output.Bytes(), err
}

func rawMap(value any) any {
    encoded, err := json.Marshal(value)
    check("synthetic-json-marshal", err == nil)
    var raw any
    decoder := json.NewDecoder(bytes.NewReader(encoded))
    decoder.UseNumber()
    check("synthetic-json-decode", decoder.Decode(&raw) == nil)
    return raw
}

func object(name, format string, value any) map[string]any {
    encoded, err := render(format, value, false)
    check(name + ":typed-execution", err == nil)
    check(name + ":no-sensitive-field-output", !bytes.Contains(encoded, []byte("synthetic-sensitive-marker")))
    var parsed map[string]any
    check(name + ":json", json.Unmarshal(encoded, &parsed) == nil)
    return parsed
}

func container(input Input, volume bool) ContainerInspectResponse {
    pids := int64(32)
    command := []string{"synthetic-reviewed-command"}
    config := &Config{
        User: input.UID, WorkingDir: "/", Cmd: command,
        Entrypoint: []string{"/usr/bin/env"},
        Healthcheck: &HealthConfig{Test: []string{"NONE"}},
        Labels: map[string]string{input.LabelKey: "synthetic-owner"},
        Env: []string{"UNRELATED_SECRET=synthetic-sensitive-marker"},
    }
    for _, key := range input.ClearKeys { config.Env = append(config.Env, key + "=") }
    host := &HostConfig{
        Resources: Resources{Memory: 268435456, MemorySwap: 268435456,
            NanoCPUs: 1000000000, PidsLimit: &pids,
            Ulimits: []*Ulimit{{Name: "core", Soft: 0, Hard: 0}, {Name: "nofile", Soft: 64, Hard: 64}}},
        RestartPolicy: RestartPolicy{Name: "no"}, ReadonlyRootfs: true,
        NetworkMode: "none", IpcMode: "none", CapDrop: []string{"ALL"},
        SecurityOpt: []string{"no-new-privileges=true"}, LogConfig: LogConfig{Type: "none"},
    }
    fixture := ContainerInspectResponse{
        ContainerJSONBase: &ContainerJSONBase{ID: strings.Repeat("1", 64), Image: "sha256:" + strings.Repeat("2", 64),
            Path: "/usr/bin/env", Args: command, HostConfig: host, State: &State{Status: "created"}},
        Config: config, NetworkSettings: &NetworkSettings{Networks: map[string]*EndpointSettings{"none": {}}},
    }
    if volume {
        host.Mounts = []Mount{{Type: "volume", Target: "/opt/oracle/oradata", ReadOnly: true,
            VolumeOptions: &VolumeOptions{DriverConfig: &Driver{Name: "local"}}}}
        fixture.Mounts = []MountPoint{{Name: strings.Repeat("3", 64), Type: "volume", Driver: "local",
            Destination: "/opt/oracle/oradata", RW: false, Source: "/synthetic-sensitive-marker/host-source"}}
    }
    return fixture
}

func main() {
    encoded, err := io.ReadAll(io.LimitReader(os.Stdin, 32769))
    check("bounded-template-input", err == nil && len(encoded) <= 32768)
    var input Input
    check("template-input-json", json.Unmarshal(encoded, &input) == nil)
    check("template-input-complete", input.ImageFormat != "" && input.ContainerFormat != "" && input.CleanupFormat != "" && len(input.ClearKeys) > 0)
    for _, hasVolume := range []bool{false, true} {
        name := "zero-volume"
        volumes := []string{}
        if hasVolume { name = "one-volume"; volumes = []string{"/opt/oracle/oradata"} }
        fixture := container(input, hasVolume)
        full := object(name+":full", input.ContainerFormat, fixture)
        cleanup := object(name+":cleanup", input.CleanupFormat, fixture)
        check(name+":typed-nanocpus", full["nanoCpus"] == float64(1000000000))
        check(name+":typed-id", full["id"] == strings.Repeat("1", 64) && cleanup["id"] == full["id"])
        if !hasVolume { check(name+":nil-requested-mounts", full["requestedMounts"] == nil && cleanup["requestedMounts"] == nil) }
        result.Containers = append(result.Containers, RenderedContainer{full, cleanup, volumes})
        image := ImageInspectResponse{ID: "sha256:" + strings.Repeat("2", 64), RepoDigests: []string{input.RepoDigest},
            Os: "linux", Architecture: "amd64", Size: 1804633389, Config: &Config{}}
        if hasVolume { image.Config.Volumes = map[string]struct{}{"/opt/oracle/oradata": {}} }
        result.Images = append(result.Images, RenderedImage{object(name+":image", input.ImageFormat, image), volumes})

        // Preserve a regression for the actual old JSON-spelled template and
        // Docker's documented typed-then-strict-raw fallback behavior.
        legacy := strings.ReplaceAll(strings.ReplaceAll(input.ContainerFormat, ".ID", ".Id"), ".NanoCPUs", ".NanoCpus")
        _, typedError := render(legacy, fixture, false)
        check(name+":legacy-typed-rejected", typedError != nil)
        _, rawError := render(legacy, rawMap(fixture), true)
        if hasVolume { check(name+":legacy-raw-works", rawError == nil) } else {
            check(name+":legacy-raw-mounts-omitted", rawError != nil && strings.Contains(rawError.Error(), "Mounts"))
        }
        legacyImage := strings.ReplaceAll(input.ImageFormat, ".ID", ".Id")
        _, typedError = render(legacyImage, image, false)
        check(name+":legacy-image-typed-rejected", typedError != nil)
        _, rawError = render(legacyImage, rawMap(image), true)
        check(name+":legacy-image-raw-works", rawError == nil)
    }
    fixture := container(input, false)
    for _, misspelling := range []string{
        strings.ReplaceAll(input.ContainerFormat, ".ID", ".Id"),
        strings.ReplaceAll(input.ContainerFormat, ".NanoCPUs", ".NanoCpus"),
    } {
        _, err = render(misspelling, fixture, false)
        check("individual-field-case-regression", err != nil)
    }
    fixture.Config.Env[1] = input.ClearKeys[0] + "=synthetic-sensitive-marker"
    unsafeHooks := object("unsafe-hooks", input.ContainerFormat, fixture)
    hooks, ok := unsafeHooks["hookEnvironment"].([]any)
    check("unsafe-hook-boolean-present", ok && len(hooks) == len(input.ClearKeys)+1)
    firstHook, ok := hooks[1].(map[string]any)
    check("unsafe-hook-false-not-raw-value", ok && firstHook["cleared"] == false)
    fixture.Config.Healthcheck = nil
    withoutHealth := object("nil-healthcheck", input.ContainerFormat, fixture)
    check("nil-healthcheck-not-silently-none", withoutHealth["healthcheck"] == nil)
    object("cleanup-independent-of-healthcheck", input.CleanupFormat, fixture)
    fixture.Config = nil
    _, err = render(input.ContainerFormat, fixture, false)
    check("nil-container-config-fails-closed", err != nil)
    _, err = render(input.CleanupFormat, fixture, false)
    check("nil-cleanup-config-cannot-prove-owner", err != nil)
    _, err = render(input.ImageFormat, ImageInspectResponse{}, false)
    check("nil-image-config-fails-closed", err != nil)
    output, err := json.MarshalIndent(result, "", "  ")
    check("bounded-synthetic-output", err == nil && len(output) <= 262144)
    // Marshal once more so the final check count is included. Output is synthetic.
    output, _ = json.MarshalIndent(result, "", "  ")
    fmt.Println(string(output))
}
