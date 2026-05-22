local SignageManager = {}

-- Required Services
local Workspace = game:GetService("Workspace")

function SignageManager:DeployHolograms()
    print("🏙️ [SIGNAGE] Projectors active...")
    
    local old = Workspace:FindFirstChild("CitySignage")
    if old then old:Destroy() end
    
    local root = Instance.new("Model")
    root.Name = "CitySignage"
    root.Parent = Workspace

    -- Floating Neon Red Energy Signage
    local color = Color3.fromRGB(255, 30, 30)
    for i = 1, 20 do
        local sign = Instance.new("Part")
        sign.Size = Vector3.new(20, 40, 0.5)
        sign.Position = Vector3.new(math.random(-250, 250), 150 + math.random(0, 100), math.random(-250, 250))
        sign.Orientation = Vector3.new(0, math.random(0, 360), 0)
        sign.Color = color
        sign.Material = Enum.Material.Neon
        sign.Transparency = 0.6
        sign.CanCollide = false
        sign.Anchored = true
        sign.Parent = root
        
        local light = Instance.new("PointLight")
        light.Color = color
        light.Range = 40
        light.Brightness = 3
        light.Parent = sign
    end
end

function SignageManager:Initialize()
    self:DeployHolograms()
end

return SignageManager