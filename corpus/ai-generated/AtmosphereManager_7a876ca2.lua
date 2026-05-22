local AtmosphereManager = {}

-- Required Service
local Lighting = game:GetService("Lighting")

-- Module Variables
local currentAtmosphere = nil

-- Function to create the Atmospheric conditions for Cyber-Gothic Metropolis
local function createAtmosphere()
    -- Setup Lighting
    Lighting.Brightness = 3
    Lighting.ClockTime = 20
    Lighting.FogColor = Color3.fromRGB(30, 30, 60)
    Lighting.FogEnd = 500
    Lighting.FogStart = 10
    Lighting.OutdoorAmbient = Color3.fromRGB(15, 15, 35)
    
    -- Setup Atmosphere
    if not currentAtmosphere then
        currentAtmosphere = Instance.new("Atmosphere")
        currentAtmosphere.Density = 1.0
        currentAtmosphere.Offset = 0
        currentAtmosphere.Color = Color3.fromRGB(255, 70, 70)
        currentAtmosphere.Decay = Color3.fromRGB(20, 20, 30)
        currentAtmosphere.Glare = 0.2
        currentAtmosphere.Haze = 2
        currentAtmosphere.Parent = Lighting
    end
end

-- Function to reset atmosphere to default state
local function resetAtmosphere()
    if currentAtmosphere then
        currentAtmosphere:Destroy()
        currentAtmosphere = nil
    end
    Lighting:ClearAllChildren()
end

-- Function to set Neon Red Grids effect
local function setNeonRedGrids()
    -- Example of how Neon Red Grid effect could be adjusted
    -- Assuming we have Parts with Neon materials set in the world
    for _, part in pairs(workspace:GetChildren()) do
        if part:IsA("BasePart") and part.Material == Enum.Material.Neon then
            part.Color = Color3.fromRGB(255, 0, 0)
        end
    end
end

-- Initialize the atmosphere at runtime
function AtmosphereManager.Initialize()
    createAtmosphere()
    setNeonRedGrids()
end

-- Cleanup
function AtmosphereManager.Cleanup()
    resetAtmosphere()
end

return AtmosphereManager