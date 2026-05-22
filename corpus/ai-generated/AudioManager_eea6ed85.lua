local AudioManager = {}

-- Required Services
local SoundService = game:GetService("SoundService")
local Debris = game:GetService("Debris")

-- Configuration (Cyber-Gothic Synth IDs)
local AMBIENT_ID = "rbxassetid://1837879082" -- Dark Cinematic Synth
local DASH_SFX_ID = "rbxassetid://1347631165" -- Digital Zip

function AudioManager:IgniteWorldAudio()
    print("🎶 [AUDIO] Manifesting Metropolis Resonance...")
    
    -- Set Global Reverb for that "Massive Canyon" look
    SoundService.AmbientReverb = Enum.ReverbType.StoneCorridor
    
    -- Global Ambient Loop
    local old = SoundService:FindFirstChild("Metropolis_Heartbeat")
    if old then old:Destroy() end
    
    local music = Instance.new("Sound")
    music.Name = "Metropolis_Heartbeat"
    music.SoundId = AMBIENT_ID
    music.Volume = 0.5
    music.Looped = true
    music.Parent = SoundService
    music:Play()
    
    print("🏛️ [REVERB] Cathedral acoustics ACTIVE.")
end

function AudioManager:PlayDash()
    local sfx = Instance.new("Sound")
    sfx.SoundId = DASH_SFX_ID
    sfx.Volume = 0.8
    sfx.Parent = SoundService
    sfx:Play()
    Debris:AddItem(sfx, 1)
end

function AudioManager:Initialize()
    self:IgniteWorldAudio()
end

return AudioManager