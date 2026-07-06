
import { buildExtractCommand } from '../backend/Strategy';

const baseConfig = {
    videoPath: 'C:/videos/test.mp4',
    outputPath: 'C:/frames/frame_%08d.jpg',
    strategy: 'VLM_OPTIMIZED' as const,
    fps: 2,
    sceneThreshold: 0.28,
    minFrameInterval: 4,
    width: 1024,
    quality: 3,
    threads: 4,
};

// Test 1: sceneThreshold > 1
try {
    buildExtractCommand({ ...baseConfig, sceneThreshold: 1.5 });
    console.log('TEST 1 FAIL: No error thrown for sceneThreshold=1.5');
} catch (e) {
    console.log('TEST 1 PASS:', (e as Error).message);
}

// Test 2: minFrameInterval <= 0
try {
    buildExtractCommand({ ...baseConfig, minFrameInterval: 0 });
    console.log('TEST 2 FAIL: No error thrown for minFrameInterval=0');
} catch (e) {
    console.log('TEST 2 PASS:', (e as Error).message);
}

// Test 3: width < 0
try {
    buildExtractCommand({ ...baseConfig, width: -1 });
    console.log('TEST 3 FAIL: No error thrown for width=-1');
} catch (e) {
    console.log('TEST 3 PASS:', (e as Error).message);
}

// Test 4: fps > 120
try {
    buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS', fps: 121 });
    console.log('TEST 4 FAIL: No error thrown for fps=121');
} catch (e) {
    console.log('TEST 4 PASS:', (e as Error).message);
}

// Test 5: width = 0 - just check the args
console.log('TEST 5 args:', buildExtractCommand({ ...baseConfig, width: 0 }).join(' | '));
