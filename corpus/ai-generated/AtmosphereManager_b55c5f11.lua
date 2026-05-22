local AtmosphereManager = {}

-- Required Services
local Lighting = game:GetService("Lighting")
local SoundService = game:GetService("SoundService")

-- Configuration (Verified Mr. Robot Pulse)
local HACKER_SYNTH_ID = "rbxassetid://1837879082" -- Verified Dark Ambient

function AtmosphereManager:ApplyVisualCore()
    print("🌙 [ATMOSPHERE] Manifesting Moonlight/Visibility...")
    
    -- Visual Core (No longer pitch black)
    Lighting.ClockTime = 3 -- Pre-dawn (Moon out)
    Lighting.Brightness = 3 -- High Intensity
    Lighting.GlobalShadows = true
    
    -- GLOBAL FILL: Deep Cyber Blue (Reveals silhouettes)
    Lighting.Ambient = Color3.fromRGB(30, 30, 60) 
    Lighting.OutdoorAmbient = Color3.fromRGB(20, 20, 45)
    Lighting.ExposureCompensation = 0.5 -- Post-processing boost

    -- Clear Visibility
    Lighting.FogEnd = 5000
    Lighting.FogStart = 0
    
    -- Skybox Config
    local sky = Lighting:FindFirstChildOfClass("Sky")
    if not sky then sky = Instance.new("Sky", Lighting) end
    sky.MoonAngularSize = 25 
    sky.StarCount = 5000

    -- Bloom & Effects
    local bloom = Lighting:FindFirstChildOfClass("BloomEffect")
    if not bloom then bloom = Instance.new("BloomEffect", Lighting) end
    bloom.Intensity = 1.2
    bloom.Threshold = 0.6
    
    -- Audio Heartbeat
    SoundService.AmbientReverb = Enum.ReverbType.StoneCorridor
    
    local oldMusic = SoundService:FindFirstChild("CityResonance")
    if oldMusic then oldMusic:Destroy() end
    
    local music = Instance.new("Sound")
    music.Name = "CityResonance"
    music.SoundId = HACKER_SYNTH_ID
    music.Volume = 0.5
    music.Looped = true
    music.Parent = SoundService
    music:Play()

    -- Static Manifest (No blackouts)
    print("🎶 [SONIC] Hacker Heartbeat Active.")
end

function AtmosphereManager:Initialize()
    self:ApplyVisualCore()
end

return AtmosphereManager