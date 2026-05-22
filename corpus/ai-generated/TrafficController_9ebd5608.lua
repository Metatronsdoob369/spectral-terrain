local TrafficController = {}

-- Required Services
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")

-- Configuration (Teal/Amber Harmony)
local COLOR_CYAN = Color3.fromRGB(0, 255, 255)
local COLOR_AMBER = Color3.fromRGB(255, 180, 0)
local TRAFFIC_COUNT = 45
local SPEED = 150

function TrafficController:SpawnTraffic()
    print("🚦 [TRAFFIC] Synchronizing Harmonious Data Flows...")
    
    local old = Workspace:FindFirstChild("CityTraffic")
    if old then old:Destroy() end
    
    local root = Instance.new("Model")
    root.Name = "CityTraffic"
    root.Parent = Workspace

    local pulses = {}
    for i = 1, TRAFFIC_COUNT do
        local p = Instance.new("Part")
        p.Size = Vector3.new(1, 1, 15)
        p.Color = (math.random() > 0.5) and COLOR_CYAN or COLOR_AMBER
        p.Material = Enum.Material.Neon
        p.Transparency = 0.5
        p.Anchored = true
        p.CanCollide = false
        p.Parent = root
        
        local isXAxis = math.random() > 0.5
        local lane = math.random(-7, 7) * 80
        
        table.insert(pulses, {
            part = p,
            isXAxis = isXAxis,
            lane = lane,
            pos = math.random(-600, 600)
        })
    end

    RunService.Heartbeat:Connect(function(dt)
        for _, s in ipairs(pulses) do
            s.pos = s.pos + (SPEED * dt)
            if (s.pos > 600) then s.pos = -600 end
            if s.isXAxis then
                s.part.CFrame = CFrame.new(s.pos, 5, s.lane)
            else
                s.part.CFrame = CFrame.new(s.lane, 5, s.pos) * CFrame.Angles(0, math.rad(90), 0)
            end
        end
    end)
end

function TrafficController:Initialize()
    self:SpawnTraffic()
end

return TrafficController