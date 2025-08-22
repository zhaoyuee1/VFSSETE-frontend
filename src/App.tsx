import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000';

// 调试信息：检查环境变量
console.log('Environment Variables Debug:');
console.log('VITE_BACKEND_URL:', import.meta.env.VITE_BACKEND_URL);
console.log('All env vars:', import.meta.env);
console.log('Final BACKEND URL:', BACKEND);

// Savitzky-Golay平滑滤波函数
const savitzkyGolayFilter = (data: number[], windowSize: number = 5, order: number = 2): number[] => {
  if (data.length < windowSize) return data;
  
  const result: number[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let weightSum = 0;
    
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < data.length) {
        // 简化的权重计算（实际应用中可以使用更精确的Savitzky-Golay系数）
        const weight = Math.exp(-(j * j) / (2 * halfWindow * halfWindow));
        sum += data[idx] * weight;
        weightSum += weight;
      }
    }
    
    result.push(sum / weightSum);
  }
  
  return result;
};

// 提取吞咽周期医学参数的函数
const extractCycleParameters = (startFrame: number, endFrame: number, processedData: any[], cycleNumber: number) => {
  // 提取该周期内的数据
  const cycleData = processedData.slice(startFrame, endFrame + 1);
  
  // 参数1: 咽腔收缩率PCR (Pharyngeal Contraction Ratio)
  // 使用95%置信区间而非绝对最值，具有统计学意义
  // PCR = 最小值/最大值 = 5%分位数/95%分位数
  const pharynxZScore = cycleData.map(row => row.zscore_pharynx).filter(val => val !== null);
  
  if (pharynxZScore.length === 0) {
    return { PCR: null };
  }
  
  // 计算95%和5%分位数
  const sortedPharynx = [...pharynxZScore].sort((a, b) => a - b);
  const p95Index = Math.floor(sortedPharynx.length * 0.95);
  const p5Index = Math.floor(sortedPharynx.length * 0.05);
  const p95Value = sortedPharynx[p95Index];
  const p5Value = sortedPharynx[p5Index];
  
  // 处理Z-score负值问题：使用绝对值或偏移处理
  let adjustedP95 = p95Value;
  let adjustedP5 = p5Value;
  
  // 如果所有值都是负数，使用绝对值
  if (p95Value < 0 && p5Value < 0) {
    adjustedP95 = Math.abs(p95Value);
    adjustedP5 = Math.abs(p5Value);
    console.log(`周期 ${cycleNumber}: 检测到负值，使用绝对值处理`);
  }
  // 如果混合正负值，使用偏移处理
  else if (p95Value < 0 || p5Value < 0) {
    const minValue = Math.min(...pharynxZScore);
    const offset = Math.abs(minValue) + 0.1; // 偏移量确保所有值都为正
    adjustedP95 = p95Value + offset;
    adjustedP5 = p5Value + offset;
    console.log(`周期 ${cycleNumber}: 混合正负值，使用偏移处理，偏移量=${offset.toFixed(3)}`);
  }
  
  // PCR = 最小值/最大值 = 5%分位数/95%分位数
  const PCR = adjustedP5 / adjustedP95;
  
  console.log(`周期 ${cycleNumber}: PCR计算 - 95%分位数=${p95Value.toFixed(3)}, 5%分位数=${p5Value.toFixed(3)}`);
  console.log(`   调整后: 95%分位数=${adjustedP95.toFixed(3)}, 5%分位数=${adjustedP5.toFixed(3)}, PCR=${PCR.toFixed(3)}`);
  
  // 参数2: 误吸误咽检测 (Aspiration Risk Assessment)
  // 使用 Normalized_bolus_vestibule_overlap / Normalized_vestibule 的比值判断
  // 原因：Z-score基线不是0，会导致比值计算偏差
  const bolusVestibuleOverlap = cycleData.map(row => row.normalized_bolus_vestibule_overlap).filter(val => val !== null);
  const vestibule = cycleData.map(row => row.normalized_vestibule).filter(val => val !== null);
  
  let aspirationRisk = null;
  let maxOverlapRatio = null;
  let overlapRatioDetails = null;
  
  if (bolusVestibuleOverlap.length > 0 && vestibule.length > 0) {
    // 计算每一帧的重叠比值
    const overlapRatios = [];
    const overlapDetails = [];
    
    for (let i = 0; i < cycleData.length; i++) {
      const overlap = cycleData[i].normalized_bolus_vestibule_overlap;
      const vestibuleArea = cycleData[i].normalized_vestibule;
      
      if (overlap !== null && vestibuleArea !== null) {
        // 使用Normalized数据，基线从0开始，更准确
        let adjustedOverlap = overlap;
        let adjustedVestibule = vestibuleArea;
        
        // 如果vestibule接近0，使用小的正数避免除零
        if (Math.abs(vestibuleArea) < 0.01) {
          adjustedVestibule = 0.01;
        }
        // 如果overlap为0或接近0，说明没有误吸误咽
        else if (Math.abs(overlap) < 0.01) {
          adjustedOverlap = 0.01;
        }
        
        const ratio = adjustedOverlap / adjustedVestibule;
        overlapRatios.push(ratio);
        overlapDetails.push({
          frame: startFrame + i,
          normalizedOverlap: overlap,
          normalizedVestibule: vestibuleArea,
          adjustedOverlap: adjustedOverlap,
          adjustedVestibule: adjustedVestibule,
          ratio: ratio
        });
      }
    }
    
    if (overlapRatios.length > 0) {
      maxOverlapRatio = Math.max(...overlapRatios);
      
      // 判断误吸误咽风险
      // 阈值设定：当最大比值 < 0.2 时，认为不存在误吸误咽
      // 使用Normalized数据后，阈值可以更精确
      const aspirationThreshold = 0.2;
      aspirationRisk = maxOverlapRatio >= aspirationThreshold;
      
      overlapRatioDetails = overlapDetails;
      
      console.log(`周期 ${cycleNumber}: 误吸误咽检测 - 使用Normalized数据`);
      console.log(`   最大重叠比值=${maxOverlapRatio.toFixed(3)}, 阈值=${aspirationThreshold}, 存在风险=${aspirationRisk}`);
      console.log(`   数据范围: overlap=[${Math.min(...bolusVestibuleOverlap).toFixed(3)}, ${Math.max(...bolusVestibuleOverlap).toFixed(3)}], vestibule=[${Math.min(...vestibule).toFixed(3)}, ${Math.max(...vestibule).toFixed(3)}]`);
    }
  }
  
  // 参数3: HYB (Hyoid Burst Onset) 检测
  // 检测hyoid_c4_distance突然增加的起始帧
  const hyoidC4Distance = cycleData.map(row => row.zscore_hyoid_c4_distance).filter(val => val !== null);
  
  let HYB = null;
  let HYB_peakFrame = null;
  let HYB_valleyFrame = null;
  let HYB_peakValue = null;
  let HYB_valleyValue = null;
  
  // UESO和UESC参数
  let UESO = null;
  let UESC = null;
  let UES_peakFrame = null;
  let UES_peakValue = null;
  let UES_beforeValleyFrame = null;
  let UES_afterValleyFrame = null;
  let UES_beforeValleyValue = null;
  let UES_afterValleyValue = null;
  
  // LVC和LVCoff参数
  let LVC = null;
  let LVCoff = null;
  let LVC_peakFrame = null;
  let LVC_peakValue = null;
  let LVC_valley1Frame = null;
  let LVC_valley2Frame = null;
  let LVC_valley1Value = null;
  let LVC_valley2Value = null;
  
  if (hyoidC4Distance.length > 0) {
    // 1. 在吞咽周期内寻找hyoid_c4_distance的峰值
    let maxValue = hyoidC4Distance[0];
    let maxIndex = 0;
    
    for (let i = 1; i < hyoidC4Distance.length; i++) {
      if (hyoidC4Distance[i] > maxValue) {
        maxValue = hyoidC4Distance[i];
        maxIndex = i;
      }
    }
    
    HYB_peakValue = maxValue;
    HYB_peakFrame = startFrame + maxIndex;
    
    // 2. 计算拓宽的搜索范围（与UESO/UESC保持一致）
    // 需要从processedData中获取所有吞咽周期的信息来计算拓宽范围
    const allCycles = processedData.filter(row => row.cycleNumber !== undefined);
    const currentCycleData = allCycles.find(row => row.cycleNumber === cycleNumber);
    
    let searchStartFrame = startFrame;  // HYB搜索起始帧
    
    if (currentCycleData) {
      // 找到当前周期在processedData中的索引
      const cycleIndex = allCycles.findIndex(row => row.cycleNumber === cycleNumber);
      
      if (cycleIndex > 0) {
        // 不是第一次吞咽，HYB可以搜索到前一次吞咽的结束
        const prevCycle = allCycles[cycleIndex - 1];
        if (prevCycle && prevCycle.endFrame !== undefined) {
          searchStartFrame = Math.max(0, prevCycle.endFrame);
        }
      }
    }
    
    console.log(`周期 ${cycleNumber}: HYB搜索范围拓宽 - 起始帧: ${searchStartFrame}`);
    
    // 3. 使用斜率计算找到峰值前的第一个谷底
    // 计算一阶差分（斜率）来识别真正的谷底
    const diffData: number[] = [];
    for (let i = 1; i < hyoidC4Distance.length; i++) {
      diffData.push(hyoidC4Distance[i] - hyoidC4Distance[i - 1]);
    }
    
    // 从峰值向前搜索，找到第一个谷底（斜率从负变正的转折点）
    // 搜索范围：从峰值到拓宽的起始帧
    const searchStartInCycle = Math.max(0, searchStartFrame - startFrame);
    
    let valleyValue = maxValue;
    let valleyIndex = maxIndex;
    let foundValley = false;
    
    // 使用斜率变化检测谷底：从下降（负斜率）转为上升（正斜率）
    for (let i = maxIndex - 1; i >= searchStartInCycle; i--) {
      if (i > 0 && i - 1 < diffData.length) {
        const currentSlope = diffData[i - 1]; // 当前帧的斜率
        const nextSlope = diffData[i];        // 下一帧的斜率（向前搜索）
        
        // 谷底特征：斜率从负（下降）转为正（上升）
        if (currentSlope < 0 && nextSlope > 0) {
          valleyValue = hyoidC4Distance[i];
          valleyIndex = i;
          foundValley = true;
          break;
        }
      }
    }
    
    // 如果没有找到明显的斜率转折点，使用局部最小值作为备选方案
    if (!foundValley) {
      let localMin = maxValue;
      let localMinIndex = maxIndex;
      
      for (let i = maxIndex - 1; i >= searchStartInCycle; i--) {
        if (hyoidC4Distance[i] < localMin) {
          localMin = hyoidC4Distance[i];
          localMinIndex = i;
        }
        // 如果检测到明显上升，停止搜索
        if (i > 0 && (hyoidC4Distance[i] - hyoidC4Distance[i-1]) > 0.05) {
          break;
        }
      }
      valleyValue = localMin;
      valleyIndex = localMinIndex;
    }
    
    HYB_valleyValue = valleyValue;
    HYB_valleyFrame = startFrame + valleyIndex;
    
    // 4. HYB就是谷底帧（峰值前的第一个谷底）
    HYB = startFrame + valleyIndex;
    
    console.log(`周期 ${cycleNumber}: HYB检测完成`);
    console.log(`   峰值: 帧${HYB_peakFrame}, 值=${HYB_peakValue.toFixed(3)}`);
    console.log(`   谷底: 帧${HYB_valleyFrame}, 值=${HYB_valleyValue.toFixed(3)}`);
    console.log(`   HYB帧: ${HYB} (谷底帧)`);
    console.log(`   拓宽搜索范围: [${searchStartFrame}, ${startFrame + hyoidC4Distance.length - 1}]`);
  }
  
  // UESO和UESC检测
  const uesLength = cycleData.map(row => row.zscore_ues_length).filter(val => val !== null);
  
  if (uesLength.length > 0) {
    // 1. 在吞咽周期内寻找zscore_ues_length的峰值
    let maxValue = uesLength[0];
    let maxIndex = 0;
    
    for (let i = 1; i < uesLength.length; i++) {
      if (uesLength[i] > maxValue) {
        maxValue = uesLength[i];
        maxIndex = i;
      }
    }
    
    UES_peakValue = maxValue;
    UES_peakFrame = startFrame + maxIndex;
    
    // 2. 计算一阶差分（斜率）来识别谷底
    const diffData: number[] = [];
    for (let i = 1; i < uesLength.length; i++) {
      diffData.push(uesLength[i] - uesLength[i - 1]);
    }
    
    // 3. 计算拓宽的搜索范围
    // 需要从processedData中获取所有吞咽周期的信息来计算拓宽范围
    const allCycles = processedData.filter(row => row.cycleNumber !== undefined);
    const currentCycleData = allCycles.find(row => row.cycleNumber === cycleNumber);
    
    let searchStartFrame = startFrame;  // UESO搜索起始帧
    let searchEndFrame = startFrame + uesLength.length - 1;  // UESC搜索结束帧
    
    if (currentCycleData) {
      // 找到当前周期在processedData中的索引
      const cycleIndex = allCycles.findIndex(row => row.cycleNumber === cycleNumber);
      
      if (cycleIndex > 0) {
        // 不是第一次吞咽，UESO可以搜索到前一次吞咽的结束
        const prevCycle = allCycles[cycleIndex - 1];
        if (prevCycle && prevCycle.endFrame !== undefined) {
          searchStartFrame = Math.max(0, prevCycle.endFrame);
        }
      }
      
      if (cycleIndex < allCycles.length - 1) {
        // 不是最后一次吞咽，UESC可以搜索到下一次吞咽的开始
        const nextCycle = allCycles[cycleIndex + 1];
        if (nextCycle && nextCycle.startFrame !== undefined) {
          searchEndFrame = nextCycle.startFrame;
        }
      }
    }
    
    console.log(`周期 ${cycleNumber}: UES搜索范围拓宽 - 起始帧: ${searchStartFrame}, 结束帧: ${searchEndFrame}`);
    
    // 4. 找到峰值前的谷底（UESO）
    let beforeValleyValue = maxValue;
    let beforeValleyIndex = maxIndex;
    let foundBeforeValley = false;
    
    // 从峰值向前搜索，找到第一个谷底（斜率从负变正）
    // 搜索范围：从峰值到拓宽的起始帧
    const searchStartInCycle = Math.max(0, searchStartFrame - startFrame);
    
    for (let i = maxIndex - 1; i >= searchStartInCycle; i--) {
      if (i > 0 && i - 1 < diffData.length) {
        const currentSlope = diffData[i - 1];
        const nextSlope = diffData[i];
        
        // 谷底特征：斜率从负（下降）转为正（上升）
        if (currentSlope < 0 && nextSlope > 0) {
          beforeValleyValue = uesLength[i];
          beforeValleyIndex = i;
          foundBeforeValley = true;
          break;
        }
      }
    }
    
    // 如果没有找到明显的斜率转折点，使用局部最小值作为备选方案
    if (!foundBeforeValley) {
      let localMin = maxValue;
      let localMinIndex = maxIndex;
      
      for (let i = maxIndex - 1; i >= searchStartInCycle; i--) {
        if (uesLength[i] < localMin) {
          localMin = uesLength[i];
          localMinIndex = i;
        }
        if (i > 0 && (uesLength[i] - uesLength[i-1]) > 0.05) {
          break;
        }
      }
      beforeValleyValue = localMin;
      beforeValleyIndex = localMinIndex;
    }
    
    UES_beforeValleyValue = beforeValleyValue;
    UES_beforeValleyFrame = startFrame + beforeValleyIndex;
    UESO = startFrame + beforeValleyIndex;
    
    // 5. 找到峰值后的谷底（UESC）
    let afterValleyValue = maxValue;
    let afterValleyIndex = maxIndex;
    let foundAfterValley = false;
    
    // 从峰值向后搜索，找到第一个谷底（斜率从正变负）
    // 搜索范围：从峰值到拓宽的结束帧
    const searchEndInCycle = Math.min(uesLength.length - 1, searchEndFrame - startFrame);
    
    for (let i = maxIndex + 1; i <= searchEndInCycle; i++) {
      if (i < diffData.length) {
        const currentSlope = diffData[i];
        const prevSlope = diffData[i - 1];
        
        // 谷底特征：斜率从正（上升）转为负（下降）
        if (prevSlope > 0 && currentSlope < 0) {
          afterValleyValue = uesLength[i];
          afterValleyIndex = i;
          foundAfterValley = true;
          break;
        }
      }
    }
    
    // 如果没有找到明显的斜率转折点，使用局部最小值作为备选方案
    if (!foundAfterValley) {
      let localMin = maxValue;
      let localMinIndex = maxIndex;
      
      for (let i = maxIndex + 1; i <= searchEndInCycle; i++) {
        if (uesLength[i] < localMin) {
          localMin = uesLength[i];
          localMinIndex = i;
        }
        if (i < uesLength.length - 1 && (uesLength[i+1] - uesLength[i]) > 0.05) {
          break;
        }
      }
      afterValleyValue = localMin;
      afterValleyIndex = localMinIndex;
    }
    
    UES_afterValleyValue = afterValleyValue;
    UES_afterValleyFrame = startFrame + afterValleyIndex;
    UESC = startFrame + afterValleyIndex;
    
    console.log(`周期 ${cycleNumber}: UES检测完成`);
    console.log(`   峰值: 帧${UES_peakFrame}, 值=${UES_peakValue.toFixed(3)}`);
    console.log(`   峰值前谷底(UESO): 帧${UES_beforeValleyFrame}, 值=${UES_beforeValleyValue.toFixed(3)}`);
    console.log(`   峰值后谷底(UESC): 帧${UES_afterValleyFrame}, 值=${UES_afterValleyValue.toFixed(3)}`);
    console.log(`   UESO帧: ${UESO}, UESC帧: ${UESC}`);
    console.log(`   拓宽搜索范围: [${searchStartFrame}, ${searchEndFrame}]`);
  }
  
  // LVC和LVCoff检测
  const vestibuleData = cycleData.map(row => row.zscore_vestibule).filter(val => val !== null);
  
  if (vestibuleData.length > 0) {
    // 1. 计算拓宽的搜索范围（与HYB/UESO/UESC保持一致）
    const allCycles = processedData.filter(row => row.cycleNumber !== undefined);
    const currentCycleData = allCycles.find(row => row.cycleNumber === cycleNumber);
    
    let searchStartFrame = startFrame;  // LVC搜索起始帧
    let searchEndFrame = startFrame + vestibule.length - 1;  // LVCoff搜索结束帧
    
    if (currentCycleData) {
      const cycleIndex = allCycles.findIndex(row => row.cycleNumber === cycleNumber);
      
      if (cycleIndex > 0) {
        // 不是第一次吞咽，LVC可以搜索到前一次吞咽的结束
        const prevCycle = allCycles[cycleIndex - 1];
        if (prevCycle && prevCycle.endFrame !== undefined) {
          searchStartFrame = Math.max(0, prevCycle.endFrame);
        }
      }
      
      if (cycleIndex < allCycles.length - 1) {
        // 不是最后一次吞咽，LVCoff可以搜索到下一次吞咽的开始
        const nextCycle = allCycles[cycleIndex + 1];
        if (nextCycle && nextCycle.startFrame !== undefined) {
          searchEndFrame = nextCycle.startFrame;
        }
      }
    }
    
    console.log(`周期 ${cycleNumber}: LVC搜索范围拓宽 - 起始帧: ${searchStartFrame}, 结束帧: ${searchEndFrame}`);
    
    // 2. 计算一阶差分（斜率）来识别谷底和峰值
    const diffData: number[] = [];
    for (let i = 1; i < vestibuleData.length; i++) {
      diffData.push(vestibuleData[i] - vestibuleData[i - 1]);
    }
    
    // 3. 找到谷底1（喉前庭关闭后的最低点）
    let valley1Value = vestibuleData[0];
    let valley1Index = 0;
    let foundValley1 = false;
    
    // 在拓宽的搜索范围内寻找最低值
    const searchStartInCycle = Math.max(0, searchStartFrame - startFrame);
    const searchEndInCycle = Math.min(vestibuleData.length - 1, searchEndFrame - startFrame);
    
    for (let i = searchStartInCycle; i <= searchEndInCycle; i++) {
      if (vestibuleData[i] < valley1Value) {
        valley1Value = vestibuleData[i];
        valley1Index = i;
      }
    }
    
    LVC_valley1Value = valley1Value;
    LVC_valley1Frame = startFrame + valley1Index;
    
    // 4. 从谷底1向前搜索，找到第一个峰值（LVC）
    let peakValue = valley1Value;
    let peakIndex = valley1Index;
    let foundPeak = false;
    
    // 计算二阶差分（加速度变化）来识别真正的转折点
    const secondDiffData: number[] = [];
    for (let i = 1; i < diffData.length; i++) {
      secondDiffData.push(diffData[i] - diffData[i - 1]);
    }
    
    // 从谷底1向前搜索峰值，使用二阶差分和更高的阈值
    for (let i = valley1Index - 1; i >= searchStartInCycle; i--) {
      if (i > 1 && i - 2 < secondDiffData.length) {
        const currentSecondDiff = secondDiffData[i - 2];
        const nextSecondDiff = secondDiffData[i - 1];
        
        // 峰值特征：二阶差分从正（加速上升）转为负（减速/开始下降）
        // 使用更高的阈值来避免微小波动
        if (currentSecondDiff > 0.1 && nextSecondDiff < -0.1) {
          peakValue = vestibuleData[i];
          peakIndex = i;
          foundPeak = true;
          break;
        }
      }
    }
    
    // 如果没有找到明显的二阶差分转折点，使用一阶差分作为备选方案
    if (!foundPeak) {
      for (let i = valley1Index - 1; i >= searchStartInCycle; i--) {
        if (i > 0 && i - 1 < diffData.length) {
          const currentSlope = diffData[i - 1];
          const nextSlope = diffData[i];
          
          // 使用更高的阈值来避免微小波动
          if (currentSlope > 0.15 && nextSlope < -0.15) {
            peakValue = vestibuleData[i];
            peakIndex = i;
            foundPeak = true;
            break;
          }
        }
      }
    }
    
    // 如果仍然没有找到，使用局部最大值作为最后备选方案
    if (!foundPeak) {
      let localMax = valley1Value;
      let localMaxIndex = valley1Index;
      
      for (let i = valley1Index - 1; i >= searchStartInCycle; i--) {
        if (vestibuleData[i] > localMax) {
          localMax = vestibuleData[i];
          localMaxIndex = i;
        }
        // 使用更高的阈值来避免微小波动
        if (i > 0 && (vestibuleData[i+1] - vestibuleData[i]) < -0.15) {
          break;
        }
      }
      peakValue = localMax;
      peakIndex = localMaxIndex;
    }
    
    LVC_peakValue = peakValue;
    LVC_peakFrame = startFrame + peakIndex;
    LVC = startFrame + peakIndex;
    
    // 5. 从谷底1向后搜索，找到谷底2（LVCoff）
    let valley2Value = valley1Value;
    let valley2Index = valley1Index;
    let foundValley2 = false;
    
    // 从谷底1向后搜索，找到下一个谷底，使用二阶差分和更高阈值
    for (let i = valley1Index + 1; i <= searchEndInCycle; i++) {
      if (i > 1 && i - 2 < secondDiffData.length) {
        const currentSecondDiff = secondDiffData[i - 2];
        const nextSecondDiff = secondDiffData[i - 1];
        
        // 谷底特征：二阶差分从负（加速下降）转为正（减速/开始上升）
        // 使用更高的阈值来避免微小波动
        if (currentSecondDiff < -0.1 && nextSecondDiff > 0.1) {
          valley2Value = vestibuleData[i];
          valley2Index = i;
          foundValley2 = true;
          break;
        }
      }
    }
    
    // 如果没有找到明显的二阶差分转折点，使用一阶差分作为备选方案
    if (!foundValley2) {
      for (let i = valley1Index + 1; i <= searchEndInCycle; i++) {
        if (i > 0 && i - 1 < diffData.length) {
          const currentSlope = diffData[i - 1];
          const nextSlope = diffData[i];
          
          // 使用更高的阈值来避免微小波动
          if (currentSlope < -0.15 && nextSlope > 0.15) {
            valley2Value = vestibuleData[i];
            valley2Index = i;
            foundValley2 = true;
            break;
          }
        }
      }
    }
    
    // 如果仍然没有找到，使用局部最小值作为最后备选方案
    if (!foundValley2) {
      let localMin = valley1Value;
      let localMinIndex = valley1Index;
      
      for (let i = valley1Index + 1; i <= searchEndInCycle; i++) {
        if (vestibuleData[i] < localMin) {
          localMin = vestibuleData[i];
          localMinIndex = i;
        }
        // 使用更高的阈值来避免微小波动
        if (i < vestibuleData.length - 1 && (vestibuleData[i+1] - vestibuleData[i]) > 0.15) {
          break;
        }
      }
      valley2Value = localMin;
      valley2Index = localMinIndex;
    }
    
    LVC_valley2Value = valley2Value;
    LVC_valley2Frame = startFrame + valley2Index;
    LVCoff = startFrame + valley2Index;
    
    console.log(`周期 ${cycleNumber}: LVC检测完成（使用二阶差分提高精度）`);
    console.log(`   谷底1: 帧${LVC_valley1Frame}, 值=${LVC_valley1Value.toFixed(3)}`);
    console.log(`   峰值(LVC): 帧${LVC_peakFrame}, 值=${LVC_peakValue.toFixed(3)}`);
    console.log(`   谷底2(LVCoff): 帧${LVC_valley2Frame}, 值=${LVC_valley2Value.toFixed(3)}`);
    console.log(`   LVC帧: ${LVC}, LVCoff帧: ${LVCoff}`);
    console.log(`   拓宽搜索范围: [${searchStartFrame}, ${searchEndFrame}]`);
    console.log(`   检测方法: 二阶差分阈值±0.1，一阶差分阈值±0.15`);
  }
  
  return {
    PCR: PCR,
    PCR_p95: p95Value,
    PCR_p5: p5Value,
    PCR_adjusted_p95: adjustedP95,
    PCR_adjusted_p5: adjustedP5,
    PCR_frames: pharynxZScore.length,
    PCR_hasNegativeValues: p95Value < 0 || p5Value < 0,
    // 误吸误咽参数
    aspirationRisk: aspirationRisk,
    maxOverlapRatio: maxOverlapRatio,
    aspirationThreshold: 0.2,
    overlapRatioDetails: overlapRatioDetails,
    // HYB参数
    HYB: HYB,
    HYB_peakFrame: HYB_peakFrame,
    HYB_valleyFrame: HYB_valleyFrame,
    HYB_peakValue: HYB_peakValue,
    HYB_valleyValue: HYB_valleyValue,
    // UESO和UESC参数
    UESO: UESO,
    UESC: UESC,
    UES_peakFrame: UES_peakFrame,
    UES_peakValue: UES_peakValue,
    UES_beforeValleyFrame: UES_beforeValleyFrame,
    UES_afterValleyFrame: UES_afterValleyFrame,
    UES_beforeValleyValue: UES_beforeValleyValue,
    UES_afterValleyValue: UES_afterValleyValue,
    // LVC和LVCoff参数
    LVC: LVC,
    LVCoff: LVCoff,
    LVC_peakFrame: LVC_peakFrame,
    LVC_peakValue: LVC_peakValue,
    LVC_valley1Frame: LVC_valley1Frame,
    LVC_valley2Frame: LVC_valley2Frame,
    LVC_valley1Value: LVC_valley1Value,
    LVC_valley2Value: LVC_valley2Value
  };
};

// 吞咽周期检测函数
const detectSwallowingCycles = (zscoreData: number[], processedData: any[], fps: number = 30, minPeakHeight: number = 0.3, minCycleLength: number = 15) => {
  if (zscoreData.length < minCycleLength) return [];
  
  // 使用较小的窗口进行平滑，保留更多细节
  const smoothedData = savitzkyGolayFilter(zscoreData, 5, 2);
  
  // 计算一阶差分，用于检测趋势变化
  const diffData = [];
  for (let i = 1; i < smoothedData.length; i++) {
    diffData.push(smoothedData[i] - smoothedData[i - 1]);
  }
  
  // 检测峰值（局部最大值）- 降低阈值以捕获更多峰值
  const peaks: number[] = [];
  
  // 使用滑动窗口检测峰值
  const windowSize = 3; // 减小窗口大小，更敏感
  for (let i = windowSize; i < smoothedData.length - windowSize; i++) {
    let isPeak = true;
    
    // 检查是否为峰值
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j !== i && smoothedData[j] >= smoothedData[i]) {
        isPeak = false;
        break;
      }
    }
    
    if (isPeak && smoothedData[i] > minPeakHeight) {
      peaks.push(i);
    }
  }
  
  // 过滤峰值，确保间隔足够大且峰值足够显著
  const filteredPeaks = [];
  for (let i = 0; i < peaks.length; i++) {
    const currentPeak = peaks[i];
    const currentValue = smoothedData[currentPeak];
    
    // 检查是否与之前的峰值间隔足够大
    let isSignificant = true;
    for (let j = 0; j < filteredPeaks.length; j++) {
      const prevPeak = filteredPeaks[j];
      const prevValue = smoothedData[prevPeak];
      const frameDiff = Math.abs(currentPeak - prevPeak);
      
      // 如果间隔太小，选择值更大的峰值
      if (frameDiff < minCycleLength) {
        if (currentValue > prevValue) {
          // 移除较小的峰值
          filteredPeaks.splice(j, 1);
        } else {
          isSignificant = false;
        }
        break;
      }
    }
    
    if (isSignificant) {
      filteredPeaks.push(currentPeak);
    }
  }
  
  // 识别吞咽周期
  const swallowingCycles = [];
  let lastEndFrame = -1; // 记录上一个周期的结束帧
  
  for (let i = 0; i < filteredPeaks.length; i++) {
    const peakFrame = filteredPeaks[i];
    const peakValue = smoothedData[peakFrame];
    
    // 重新设计：基于真正的最低值作为基线，确保连续性
    let startFrame = peakFrame;
    let endFrame = peakFrame;
    
    // 1. 计算整个数据集的真正最低值作为基线
    const globalMin = Math.min(...smoothedData);
    console.log(`周期 ${i + 1}: 全局最低值 = ${globalMin.toFixed(3)}`);
    
    // 2. 寻找起始帧：从前一个周期结束帧之后开始搜索
    if (i === 0) {
      // 第1次吞咽：从第0帧开始搜索
      startFrame = 0;
      // 从第0帧向后搜索，找到第一个明显上升的点
      for (let j = 0; j < peakFrame; j++) {
        if (diffData[j] > 0.02) { // 检测到明显上升
          startFrame = j;
          break;
        }
      }
    } else {
      // 第2次及以后的吞咽：从前一次结束帧之后开始搜索
      const searchStartFrame = lastEndFrame + 1;
      console.log(`周期 ${i + 1}: 从前一次结束帧 ${lastEndFrame} 之后开始搜索，搜索起始帧 = ${searchStartFrame}`);
      
      // 在搜索范围内寻找最低点
      let localMin = smoothedData[peakFrame];
      let localMinIndex = peakFrame;
      
      for (let j = searchStartFrame; j < peakFrame; j++) {
        if (smoothedData[j] < localMin) {
          localMin = smoothedData[j];
          localMinIndex = j;
        }
      }
      
      // 从最低点向后搜索，找到激增的第一帧
      startFrame = localMinIndex;
      for (let j = localMinIndex; j < peakFrame; j++) {
        if (diffData[j] > 0.015) { // 检测到上升趋势
          startFrame = j;
          break;
        }
      }
      
      console.log(`周期 ${i + 1}: 局部最低点 = ${localMin.toFixed(3)} (帧${localMinIndex}), 起始帧 = ${startFrame}`);
    }
    
    // 3. 寻找结束帧：从峰值向后搜索，找到回到基线后的稳定期
    // 在峰值后搜索最低点
    let postLocalMin = smoothedData[peakFrame];
    let postLocalMinIndex = peakFrame;
    
    for (let j = peakFrame + 1; j < Math.min(smoothedData.length, peakFrame + 100); j++) {
      if (smoothedData[j] < postLocalMin) {
        postLocalMin = smoothedData[j];
        postLocalMinIndex = j;
      }
      // 如果开始明显上升，停止搜索
      if (j < smoothedData.length - 1 && diffData[j] > 0.02) {
        break;
      }
    }
    
    // 从后最低点向后搜索，找到稳定期的开始
    endFrame = postLocalMinIndex;
    for (let j = postLocalMinIndex; j < Math.min(smoothedData.length, postLocalMinIndex + 30); j++) {
      if (Math.abs(diffData[j]) < 0.015) { // 检测到稳定期
        endFrame = j;
        break;
      }
    }
    
    console.log(`周期 ${i + 1}: 后局部最低点 = ${postLocalMin.toFixed(3)} (帧${postLocalMinIndex}), 结束帧 = ${endFrame}`);
    
    // 4. 验证周期合理性
    const cycleLength = endFrame - startFrame;
    const isReasonableLength = cycleLength >= 5 && cycleLength <= 200;
    const isSequential = startFrame > lastEndFrame;
    const hasValidStart = startFrame < peakFrame;
    const hasValidEnd = endFrame > peakFrame;
    
    if (isReasonableLength && isSequential && hasValidStart && hasValidEnd) {
      // 5. 提取该吞咽周期的医学参数
      const cycleParameters = extractCycleParameters(
        startFrame, 
        endFrame, 
        processedData, 
        i + 1
      );
      
      swallowingCycles.push({
        cycleNumber: i + 1,
        startFrame: startFrame,
        peakFrame: peakFrame,
        endFrame: endFrame,
        peakValue: peakValue,
        duration: cycleLength,
        startTime: startFrame / fps,
        endTime: endFrame / fps,
        durationTime: cycleLength / fps,
        // 添加医学参数
        ...cycleParameters
      });
      
      // 更新上一个周期的结束帧
      lastEndFrame = endFrame;
      console.log(`✅ 周期 ${i + 1} 成功: 起始帧=${startFrame}, 峰值帧=${peakFrame}, 结束帧=${endFrame}, 长度=${cycleLength}`);
      console.log(`   医学参数: PCR=${cycleParameters.PCR?.toFixed(3)}, 其他参数...`);
    } else {
      console.warn(`❌ 周期 ${i + 1} 被跳过: 起始帧=${startFrame}, 峰值帧=${peakFrame}, 上一个结束帧=${lastEndFrame}, 周期长度=${cycleLength}`);
      console.warn(`   合理性=${isReasonableLength}, 连续性=${isSequential}, 有效起始=${hasValidStart}, 有效结束=${hasValidEnd}`);
    }
  }
  
  return {
    cycles: swallowingCycles,
    totalSwallows: swallowingCycles.length,
    smoothedData: smoothedData,
    diffData: diffData,
    peaks: filteredPeaks
  };
};

// 高级数据处理函数 - 包含Z-score标准化
const processAdvancedData = (originalAreas: any[], referenceC2C4: number) => {
  // 提取需要处理的数据
  const dataToProcess = {
    bolus_pharynx_overlap: originalAreas.map(a => a.bolus_pharynx_overlap),
    bolus_vestibule_overlap: originalAreas.map(a => a.bolus_vestibule_overlap),
    pharynx: originalAreas.map(a => a.pharynx),
    vestibule: originalAreas.map(a => a.vestibule),
    bolus: originalAreas.map(a => a.bolus || 0), // 添加bolus面积
    hyoid_c4_distance: originalAreas.map(a => a.hyoid_c4_distance),
    ues_length: originalAreas.map(a => a.ues_length),
    c2c4_length: originalAreas.map(a => a.c2c4_length)
  };
  
  // 应用Savitzky-Golay平滑（2阶）
  const smoothedData = {
    bolus_pharynx_overlap: savitzkyGolayFilter(dataToProcess.bolus_pharynx_overlap, 5, 2),
    bolus_vestibule_overlap: savitzkyGolayFilter(dataToProcess.bolus_vestibule_overlap, 5, 2),
    pharynx: savitzkyGolayFilter(dataToProcess.pharynx, 5, 2),
    vestibule: savitzkyGolayFilter(dataToProcess.vestibule, 5, 2),
    bolus: savitzkyGolayFilter(dataToProcess.bolus, 5, 2),
    hyoid_c4_distance: savitzkyGolayFilter(dataToProcess.hyoid_c4_distance.filter(d => d !== null), 5, 2),
    ues_length: savitzkyGolayFilter(dataToProcess.ues_length.filter(d => d !== null), 5, 2),
    c2c4_length: savitzkyGolayFilter(dataToProcess.c2c4_length.filter(d => d !== null && d > 0), 5, 2)
  };
  
  // 归一化处理
  const normalizedData = originalAreas.map((area, index) => {
    const c2c4Length = smoothedData.c2c4_length[index] || area.c2c4_length;
    if (!c2c4Length || c2c4Length <= 0) {
      return {
        frame: index,
        smoothed_bolus_pharynx_overlap: smoothedData.bolus_pharynx_overlap[index],
        smoothed_bolus_vestibule_overlap: smoothedData.bolus_vestibule_overlap[index],
        smoothed_pharynx: smoothedData.pharynx[index],
        smoothed_vestibule: smoothedData.vestibule[index],
        smoothed_bolus: smoothedData.bolus[index],
        normalized_bolus_pharynx_overlap: null,
        normalized_bolus_vestibule_overlap: null,
        normalized_pharynx: null,
        normalized_vestibule: null,
        normalized_bolus: null,
        normalized_hyoid_c4_distance: null,
        normalized_ues_length: null,
        zscore_bolus_pharynx_overlap: null,
        zscore_bolus_vestibule_overlap: null,
        zscore_pharynx: null,
        zscore_vestibule: null,
        zscore_bolus: null,
        zscore_hyoid_c4_distance: null,
        zscore_ues_length: null
      };
    }
    
    const scaleFactor = referenceC2C4 / c2c4Length;
    const scaleFactorSquared = scaleFactor * scaleFactor;
    
    return {
      frame: index,
      smoothed_bolus_pharynx_overlap: smoothedData.bolus_pharynx_overlap[index],
      smoothed_bolus_vestibule_overlap: smoothedData.bolus_vestibule_overlap[index],
      smoothed_pharynx: smoothedData.pharynx[index],
      smoothed_vestibule: smoothedData.vestibule[index],
      smoothed_bolus: smoothedData.bolus[index],
      // 面积归一化（线性关系）
      normalized_bolus_pharynx_overlap: smoothedData.bolus_pharynx_overlap[index] * scaleFactor,
      normalized_bolus_vestibule_overlap: smoothedData.bolus_vestibule_overlap[index] * scaleFactor,
      normalized_pharynx: smoothedData.pharynx[index] * scaleFactor,
      normalized_vestibule: smoothedData.vestibule[index] * scaleFactor,
      normalized_bolus: smoothedData.bolus[index] * scaleFactor,
      // 距离归一化（平方关系）
      normalized_hyoid_c4_distance: smoothedData.hyoid_c4_distance[index] !== null 
        ? smoothedData.hyoid_c4_distance[index] * scaleFactorSquared 
        : null,
      normalized_ues_length: smoothedData.ues_length[index] !== null 
        ? smoothedData.ues_length[index] * scaleFactorSquared 
        : null,
      // Z-score标准化（将在下面计算）
      zscore_bolus_pharynx_overlap: null,
      zscore_bolus_vestibule_overlap: null,
      zscore_pharynx: null,
      zscore_vestibule: null,
      zscore_bolus: null,
      zscore_hyoid_c4_distance: null,
      zscore_ues_length: null
    };
  });
  
  // 计算分组Z-score标准化
  const areaParameterNames = [
    'normalized_bolus_pharynx_overlap', 'normalized_bolus_vestibule_overlap',
    'normalized_pharynx', 'normalized_vestibule', 'normalized_bolus'
  ];
  
  const distanceParameterNames = [
    'normalized_hyoid_c4_distance', 'normalized_ues_length'
  ];
  
  // 分别计算面积参数和长度/距离参数的Z-score
  const calculateGroupZScore = (paramNames: string[], data: any[]) => {
    // 收集该组参数的所有有效值
    const groupValues: number[] = [];
    paramNames.forEach(paramName => {
      const values = data.map((row: any) => row[paramName]).filter((v: any) => v !== null);
      if (values.length > 0) {
        groupValues.push(...values);
      }
    });
    
    if (groupValues.length === 0) return { mean: 0, stdDev: 1 };
    
    // 计算该组的均值和标准差
    const mean = groupValues.reduce((sum, val) => sum + val, 0) / groupValues.length;
    const variance = groupValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / groupValues.length;
    const stdDev = Math.sqrt(variance);
    
    return { mean, stdDev: stdDev > 0 ? stdDev : 1 };
  };
  
  // 计算面积参数组的Z-score
  const areaStats = calculateGroupZScore(areaParameterNames, normalizedData);
  
  // 计算长度/距离参数组的Z-score
  const distanceStats = calculateGroupZScore(distanceParameterNames, normalizedData);
  
  // 应用分组Z-score标准化
  normalizedData.forEach((row: any) => {
    // 面积参数使用面积组的统计量
    areaParameterNames.forEach(paramName => {
      const normalizedValue = row[paramName];
      if (normalizedValue !== null) {
        const zscoreParamName = paramName.replace('normalized_', 'zscore_');
        row[zscoreParamName] = (normalizedValue - areaStats.mean) / areaStats.stdDev;
      }
    });
    
    // 长度/距离参数使用长度/距离组的统计量
    distanceParameterNames.forEach(paramName => {
      const normalizedValue = row[paramName];
      if (normalizedValue !== null) {
        const zscoreParamName = paramName.replace('normalized_', 'zscore_');
        row[zscoreParamName] = (normalizedValue - distanceStats.mean) / distanceStats.stdDev;
      }
    });
  });
  
  return {
    reference: referenceC2C4,
    processedData: normalizedData,
    areaStats: {
      mean: areaStats.mean,
      stdDev: areaStats.stdDev,
      parameterCount: areaParameterNames.length
    },
    distanceStats: {
      mean: distanceStats.mean,
      stdDev: distanceStats.stdDev,
      parameterCount: distanceParameterNames.length
    }
  };
};

type JobStatus = 'pending' | 'running' | 'done' | 'error';

type PreviewItem = {
  frame_index: number;
  mask_url: string;
  overlay_url?: string;
  // 新增：特殊时刻帧信息
  frame_name?: string;  // 帧的命名
  is_special_moment?: boolean;  // 是否为特殊时刻帧
};

type Summary = {
  frames: number;
  num_classes: number;
  per_class_total: number[];
  per_class_avg: number[];
  preview: PreviewItem[];
  signals?: {
    areas: Array<{ 
      pharynx: number; 
      vestibule: number; 
      bolus: number;
      // 新增：bolus重叠面积
      bolus_pharynx_overlap: number;
      bolus_vestibule_overlap: number;
      // 新增：相对坐标参数
      c2c4_length: number | null;
      hyoid_relative_x: number | null;
      hyoid_relative_y: number | null;
      hyoid_c4_distance: number | null;
      ues_length: number | null;
      coordinate_system_valid: boolean;
      // 新增：bolus流动线参数
      bolus_front_x: number | null;
      bolus_front_y: number | null;
      bolus_back_x: number | null;
      bolus_back_y: number | null;
      bolus_track_length: number | null;
      bolus_track_valid: boolean;
    }>;
    points: Array<{
      UESout?: { x: number; y: number; p: number } | null;
      UESin?: { x: number; y: number; p: number } | null;
      C2?: { x: number; y: number; p: number } | null;
      C4?: { x: number; y: number; p: number } | null;
      hyoid?: { x: number; y: number; p: number } | null;
    }>;
  };
  // 新增：视频帧率信息
  fps?: number;
};



function App() {
  const [file, setFile] = useState<File | null>(null);
  const [polyThresh, setPolyThresh] = useState<number>(0.5);
  const [pointThresh, setPointThresh] = useState<number>(0.5);
  const [pointRadius, setPointRadius] = useState<number>(6);

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showNormalized, setShowNormalized] = useState(true); // 新增：控制是否显示归一化数据
  const [showAdvancedAnalysis, setShowAdvancedAnalysis] = useState(false); // 新增：控制是否显示高级分析
  const [advancedData, setAdvancedData] = useState<any>(null); // 新增：存储高级分析数据
  const [processingAdvanced, setProcessingAdvanced] = useState(false); // 新增：高级分析处理状态
  const [advancedAnalysisError, setAdvancedAnalysisError] = useState<string | null>(null); // 新增：高级分析错误信息
  const pollTimer = useRef<number | null>(null);

  const overlayBase = useMemo(() => (jobId ? `${BACKEND}/jobs/${jobId}/frames` : ''), [jobId]);

  const onSubmit = async () => {
    if (!file) {
      alert('请选择视频文件');
      return;
    }
    try {
      setSubmitting(true);
      setSummary(null);
      setJobId(null);
      setJobStatus(null);
      setShowAdvancedAnalysis(false); // 重置高级分析状态
      setAdvancedData(null);

      const form = new FormData();
      form.append('file', file, file.name);

      const url = `${BACKEND}/analyze_video/?save_overlays=true&poly_thresh=${polyThresh}&point_thresh=${pointThresh}&point_radius=${pointRadius}`;
      const resp = await axios.post(url, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      const { job_id } = resp.data;
      setJobId(job_id);
      setJobStatus('pending');
    } catch (e: any) {
      console.error(e);
      alert('提交失败，请检查后端是否启动以及参数是否正确');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!jobId) return;

    const poll = async () => {
      try {
        const s = await axios.get(`${BACKEND}/jobs/${jobId}/status`);
        const st: JobStatus = s.data.status;
        setJobStatus(st);
        if (st === 'done') {
          // 取结果
          const r = await axios.get(`${BACKEND}/jobs/${jobId}/result`);
          setSummary(r.data.summary);
          if (pollTimer.current) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        } else if (st === 'error') {
          if (pollTimer.current) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
          alert(`任务失败: ${s.data.error || '未知错误'}`);
        }
      } catch (e) {
        console.error(e);
      }
    };

    // 立即拉一次，然后每秒轮询
    poll();
    pollTimer.current = window.setInterval(poll, 1000);

    return () => {
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [jobId]);

  // 处理高级分析
  const handleAdvancedAnalysis = async () => {
    if (!summary?.signals?.areas) {
      alert('请先完成基础分析');
      return;
    }

    try {
      setProcessingAdvanced(true);
      setAdvancedAnalysisError(null); // 清除之前的错误信息
      console.log('开始高级分析处理...');
      
      // 计算c2c4_length的中值作为reference
      const validC2C4Lengths = summary.signals.areas
        .map(area => area.c2c4_length)
        .filter(length => length !== null && length > 0);
      
      console.log('有效C2C4长度数量:', validC2C4Lengths.length);
      
      if (validC2C4Lengths.length === 0) {
        throw new Error('没有有效的C2C4长度数据');
      }
      
      const sortedLengths = [...validC2C4Lengths].sort((a, b) => a! - b!);
      const midIndex = Math.floor(sortedLengths.length / 2);
      const reference = sortedLengths.length % 2 === 0 
        ? (sortedLengths[midIndex - 1]! + sortedLengths[midIndex]!) / 2
        : sortedLengths[midIndex]!;
      
      console.log('参考C2C4长度:', reference);
      
      // 处理高级数据
      console.log('开始处理高级数据...');
      const processedData = processAdvancedData(summary.signals.areas, reference);
      console.log('高级数据处理完成:', processedData);
      
      // 检测吞咽周期
      console.log('开始检测吞咽周期...');
      const zscoreBolusPharynxOverlap = processedData.processedData.map((row: any) => row.zscore_bolus_pharynx_overlap);
      console.log('Z-score数据长度:', zscoreBolusPharynxOverlap.length);
      console.log('Z-score数据样本:', zscoreBolusPharynxOverlap.slice(0, 10));
      
      let swallowingAnalysis = detectSwallowingCycles(zscoreBolusPharynxOverlap, processedData.processedData, summary.fps || 30);
      console.log('吞咽周期检测完成:', swallowingAnalysis);
      
      // 验证吞咽分析结果
      if (!swallowingAnalysis || !('cycles' in swallowingAnalysis) || !swallowingAnalysis.cycles || swallowingAnalysis.cycles.length === 0) {
        console.warn('未检测到吞咽周期，尝试调整参数...');
        // 尝试使用更宽松的参数
        const relaxedAnalysis = detectSwallowingCycles(zscoreBolusPharynxOverlap, processedData.processedData, summary.fps || 30, 0.1, 10);
        console.log('宽松参数检测结果:', relaxedAnalysis);
        
        if (relaxedAnalysis && 'cycles' in relaxedAnalysis && relaxedAnalysis.cycles && relaxedAnalysis.cycles.length > 0) {
          console.log('使用宽松参数成功检测到吞咽周期');
          swallowingAnalysis = relaxedAnalysis;
        } else {
          console.warn('即使使用宽松参数仍未检测到吞咽周期');
        }
      }
      
      const finalAdvancedData = {
        ...processedData,
        swallowingAnalysis
      };
      
      console.log('设置高级分析数据:', finalAdvancedData);
      setAdvancedData(finalAdvancedData);
      setShowAdvancedAnalysis(true);
      
      // 生成并下载新的CSV
      console.log('生成CSV文件...');
      generateAdvancedCSV(processedData);
      
      console.log('高级分析完成！');
      
    } catch (error) {
      console.error('高级分析处理失败:', error);
      console.error('错误详情:', error);
      
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      setAdvancedAnalysisError(`高级分析处理失败: ${errorMessage}`);
      
      // 重置状态，避免前端空白
      setAdvancedData(null);
      setShowAdvancedAnalysis(false);
      
      // 显示错误信息但不弹窗，避免干扰用户体验
      console.error('高级分析错误:', errorMessage);
    } finally {
      setProcessingAdvanced(false);
    }
  };

  // 生成高级分析CSV - 包含Z-score数据
  const generateAdvancedCSV = (data: any) => {
    const csvContent = [
      'Frame,Smoothed_bolus_pharynx_overlap,Smoothed_bolus_vestibule_overlap,Smoothed_pharynx,Smoothed_vestibule,Smoothed_bolus,Normalized_bolus_pharynx_overlap,Normalized_bolus_vestibule_overlap,Normalized_pharynx,Normalized_vestibule,Normalized_bolus,Normalized_hyoid_c4_distance,Normalized_ues_length,ZScore_bolus_pharynx_overlap,ZScore_bolus_vestibule_overlap,ZScore_pharynx,ZScore_vestibule,ZScore_bolus,ZScore_hyoid_c4_distance,ZScore_ues_length',
      ...data.processedData.map((row: any) => [
        row.frame,
        row.smoothed_bolus_pharynx_overlap?.toFixed(2) || '',
        row.smoothed_bolus_vestibule_overlap?.toFixed(2) || '',
        row.smoothed_pharynx?.toFixed(2) || '',
        row.smoothed_vestibule?.toFixed(2) || '',
        row.smoothed_bolus?.toFixed(2) || '',
        row.normalized_bolus_pharynx_overlap?.toFixed(2) || '',
        row.normalized_bolus_vestibule_overlap?.toFixed(2) || '',
        row.normalized_pharynx?.toFixed(2) || '',
        row.normalized_vestibule?.toFixed(2) || '',
        row.normalized_bolus?.toFixed(2) || '',
        row.normalized_hyoid_c4_distance?.toFixed(2) || '',
        row.normalized_ues_length?.toFixed(2) || '',
        row.zscore_bolus_pharynx_overlap?.toFixed(3) || '',
        row.zscore_bolus_vestibule_overlap?.toFixed(3) || '',
        row.zscore_pharynx?.toFixed(3) || '',
        row.zscore_vestibule?.toFixed(3) || '',
        row.zscore_bolus?.toFixed(3) || '',
        row.zscore_hyoid_c4_distance?.toFixed(3) || '',
        row.zscore_ues_length?.toFixed(3) || ''
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `advanced_analysis_${Date.now()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const hyoidChartOption = useMemo(() => {
    const areas = summary?.signals?.areas ?? [];
    if (!areas.length) return undefined;
    
    // 使用相对坐标，过滤掉无效数据
    const validData = areas
      .map((area, frameIdx) => ({
        frame: frameIdx,
        x: area.hyoid_relative_x,
        y: area.hyoid_relative_y,
        valid: area.coordinate_system_valid && 
               area.hyoid_relative_x !== null && 
               area.hyoid_relative_y !== null
      }))
      .filter(item => item.valid);
    
    if (!validData.length) return undefined;

    // 分离轨迹点和连接线
    const scatterData = validData.map(item => [item.x, item.y]);
    const lineData = validData.map(item => [item.x, item.y]);

    // 计算坐标范围，添加边距
    const xValues = validData.map(item => item.x!);
    const yValues = validData.map(item => item.y!);
    const xRange = Math.max(...xValues) - Math.min(...xValues);
    const yRange = Math.max(...yValues) - Math.min(...yValues);
    const margin = Math.max(xRange, yRange) * 0.1; // 10%边距

    return {
      title: { 
        text: 'Hyoid Trajectory (Relative Coordinates)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: {
        trigger: 'item',
        formatter: function(params: any) {
          if (params.componentType === 'series') {
            const dataIndex = params.dataIndex;
            const item = validData[dataIndex];
            return `Frame: ${item.frame}<br/>X: ${item.x?.toFixed(2)}<br/>Y: ${item.y?.toFixed(2)}`;
          }
          return '';
        }
      },
      legend: { 
        data: ['Hyoid Position', 'Trajectory'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      grid: { 
        left: 60, 
        right: 20, 
        top: 120, 
        bottom: 50,
        containLabel: true
      },
      xAxis: { 
        type: 'value', 
        name: 'Relative X (perpendicular to C2C4)',
        nameLocation: 'middle',
        nameGap: 30,
        min: Math.min(...xValues) - margin,
        max: Math.max(...xValues) + margin,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e0e0e0' } },
        axisLine: { lineStyle: { color: '#333' } },
        axisTick: { show: true }
      },
      yAxis: { 
        type: 'value', 
        name: 'Relative Y (along C2C4)',
        nameLocation: 'middle',
        nameGap: 40,
        min: Math.min(...yValues) - margin,
        max: Math.max(...yValues) + margin,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e0e0e0' } },
        axisLine: { lineStyle: { color: '#333' } },
        axisTick: { show: true }
      },
      series: [
        { 
          type: 'scatter', 
          name: 'Hyoid Position',
          data: scatterData, 
          symbolSize: function(value: any, params: any) {
            // 根据帧数调整点的大小，让轨迹更清晰
            const frameIdx = validData[params.dataIndex].frame;
            if (frameIdx === 0) return 12; // 起始点更大
            if (frameIdx === validData.length - 1) return 12; // 结束点更大
            return 6; // 中间点较小
          },
          itemStyle: { 
            color: function(params: any) {
              // 根据帧数渐变颜色，显示运动方向
              const frameIdx = validData[params.dataIndex].frame;
              const progress = frameIdx / (validData.length - 1);
              return `hsl(${200 + progress * 160}, 70%, 50%)`; // 从蓝色渐变到红色
            }
          },
          emphasis: {
            itemStyle: {
              borderColor: '#fff',
              borderWidth: 2,
              shadowBlur: 10,
              shadowColor: 'rgba(0,0,0,0.3)'
            }
          }
        },
        {
          type: 'line',
          name: 'Trajectory',
          data: lineData,
          smooth: true,
          lineStyle: { 
            width: 3, 
            color: '#4ecdc4',
            shadowBlur: 5,
            shadowColor: 'rgba(0,0,0,0.2)'
          },
          showSymbol: false,
          emphasis: {
            lineStyle: { width: 5 }
          }
        }
      ],
      // 添加数据缩放功能
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      // 添加工具箱
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [summary]);

  const bolusTrajectoryChartOption = useMemo(() => {
    const areas = summary?.signals?.areas ?? [];
    if (!areas.length) return undefined;
    
    // 过滤出有效的bolus追踪数据
    const validData = areas
      .map((area, frameIdx) => ({
        frame: frameIdx,
        front_x: area.bolus_front_x,
        front_y: area.bolus_front_y,
        back_x: area.bolus_back_x,
        back_y: area.bolus_back_y,
        valid: area.bolus_track_valid && 
               area.bolus_front_x !== null && 
               area.bolus_front_y !== null &&
               area.bolus_back_x !== null && 
               area.bolus_back_y !== null
      }))
      .filter(item => item.valid);
    
    if (!validData.length) return undefined;

    // 分离前端和后端数据
    const frontData = validData.map(item => [item.front_x, item.front_y]);
    const backData = validData.map(item => [item.back_x, item.back_y]);

    // 计算坐标范围，添加边距
    const allX = [...validData.map(item => item.front_x!), ...validData.map(item => item.back_x!)];
    const allY = [...validData.map(item => item.front_y!), ...validData.map(item => item.back_y!)];
    const xRange = Math.max(...allX) - Math.min(...allX);
    const yRange = Math.max(...allY) - Math.min(...allY);
    const margin = Math.max(xRange, yRange) * 0.1; // 10%边距

    return {
      title: { 
        text: 'Bolus Front/Back End Trajectory (Relative Coordinates)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: {
        trigger: 'item',
        formatter: function(params: any) {
          const dataIndex = params.dataIndex;
          const item = validData[dataIndex];
          return `Frame: ${item.frame}<br/>
                  Front: (${item.front_x?.toFixed(2)}, ${item.front_y?.toFixed(2)})<br/>
                  Back: (${item.back_x?.toFixed(2)}, ${item.back_y?.toFixed(2)})`;
        }
      },
      legend: { 
        data: ['Front End', 'Back End', 'Front Trajectory', 'Back Trajectory'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      grid: { 
        left: 60, 
        right: 20, 
        top: 120, 
        bottom: 50,
        containLabel: true
      },
      xAxis: { 
        type: 'value', 
        name: 'Relative X (perpendicular to C2C4)',
        nameLocation: 'middle',
        nameGap: 30,
        min: Math.min(...allX) - margin,
        max: Math.max(...allX) + margin,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e0e0e0' } },
        axisLine: { lineStyle: { color: '#333' } },
        axisTick: { show: true }
      },
      yAxis: { 
        type: 'value', 
        name: 'Relative Y (along C2C4)',
        nameLocation: 'middle',
        nameGap: 40,
        min: Math.min(...allY) - margin,
        max: Math.max(...allY) + margin,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e0e0e0' } },
        axisLine: { lineStyle: { color: '#333' } },
        axisTick: { show: true }
      },
      series: [
        { 
          type: 'scatter', 
          name: 'Front End',
          data: frontData, 
          symbolSize: function(value: any, params: any) {
            // 根据帧数调整点的大小
            const frameIdx = validData[params.dataIndex].frame;
            if (frameIdx === 0) return 12; // 起始点更大
            if (frameIdx === validData.length - 1) return 12; // 结束点更大
            return 6; // 中间点较小
          },
          itemStyle: { 
            color: function(params: any) {
              // 根据帧数渐变颜色，显示运动方向
              const frameIdx = validData[params.dataIndex].frame;
              const progress = frameIdx / (validData.length - 1);
              return `hsl(${0 + progress * 60}, 80%, 60%)`; // 从红色渐变到橙色
            }
          },
          emphasis: {
            itemStyle: {
              borderColor: '#fff',
              borderWidth: 2,
              shadowBlur: 10,
              shadowColor: 'rgba(0,0,0,0.3)'
            }
          }
        },
        {
          type: 'line',
          name: 'Front Trajectory',
          data: frontData,
          smooth: true,
          lineStyle: { 
            width: 3, 
            color: '#ff6b6b',
            shadowBlur: 5,
            shadowColor: 'rgba(0,0,0,0.2)'
          },
          showSymbol: false,
          emphasis: {
            lineStyle: { width: 5 }
          }
        },
        { 
          type: 'scatter', 
          name: 'Back End',
          data: backData, 
          symbolSize: function(value: any, params: any) {
            // 根据帧数调整点的大小
            const frameIdx = validData[params.dataIndex].frame;
            if (frameIdx === 0) return 12; // 起始点更大
            if (frameIdx === validData.length - 1) return 12; // 结束点更大
            return 6; // 中间点较小
          },
          itemStyle: { 
            color: function(params: any) {
              // 根据帧数渐变颜色，显示运动方向
              const frameIdx = validData[params.dataIndex].frame;
              const progress = frameIdx / (validData.length - 1);
              return `hsl(${180 + progress * 60}, 80%, 60%)`; // 从青色渐变到蓝色
            }
          },
          emphasis: {
            itemStyle: {
              borderColor: '#fff',
              borderWidth: 2,
              shadowBlur: 10,
              shadowColor: 'rgba(0,0,0,0.3)'
            }
          }
        },
        {
          type: 'line',
          name: 'Back Trajectory',
          data: backData,
          smooth: true,
          lineStyle: { 
            width: 3, 
            color: '#4ecdc4',
            shadowBlur: 5,
            shadowColor: 'rgba(0,0,0,0.2)'
          },
          showSymbol: false,
          emphasis: {
            lineStyle: { width: 5 }
          }
        }
      ],
      // 添加数据缩放功能
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      // 添加工具箱
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [summary]);

  const downloadCsv = () => {
    if (!jobId) return;
    window.open(`${BACKEND}/jobs/${jobId}/signals.csv`, '_blank');
  };

  // 计算特殊时刻帧
  const calculateSpecialMoments = useMemo(() => {
    if (!summary?.signals?.areas) return [];
    
    const areas = summary.signals.areas;
    const fps = summary.fps || 30; // 使用实际帧率，如果没有则默认30fps
    const specialMoments: PreviewItem[] = [];
    
    // 1. 咽期吞咽起始：bolus和pharynx第一次重合
    const firstOverlapIndex = areas.findIndex(area => area.bolus_pharynx_overlap > 0);
    if (firstOverlapIndex !== -1) {
      specialMoments.push({
        frame_index: firstOverlapIndex,
        mask_url: `${BACKEND}/jobs/${jobId}/frames/${firstOverlapIndex}/mask.png`,
        overlay_url: `${BACKEND}/jobs/${jobId}/frames/${firstOverlapIndex}/overlay.png`,
        frame_name: "咽期吞咽起始",
        is_special_moment: true
      });
    }
    
    // 2. 该患者存在误吸误咽：bolus和vestibule重合面积最大的帧
    const maxVestibuleOverlapIndex = areas.reduce((maxIndex, area, index) => 
      area.bolus_vestibule_overlap > areas[maxIndex].bolus_vestibule_overlap ? index : maxIndex, 0
    );
    if (areas[maxVestibuleOverlapIndex].bolus_vestibule_overlap > 0) {
      specialMoments.push({
        frame_index: maxVestibuleOverlapIndex,
        mask_url: `${BACKEND}/jobs/${jobId}/frames/${maxVestibuleOverlapIndex}/mask.png`,
        overlay_url: `${BACKEND}/jobs/${jobId}/frames/${maxVestibuleOverlapIndex}/overlay.png`,
        frame_name: "该患者存在误吸误咽",
        is_special_moment: true
      });
    }
    
    // 3. 舌骨峰值：hyoid_c4_distance最大的帧
    const maxHyoidDistanceIndex = areas.reduce((maxIndex, area, index) => {
      if (area.hyoid_c4_distance === null || areas[maxIndex].hyoid_c4_distance === null) return maxIndex;
      return area.hyoid_c4_distance > areas[maxIndex].hyoid_c4_distance ? index : maxIndex;
    }, 0);
    if (areas[maxHyoidDistanceIndex].hyoid_c4_distance !== null) {
      specialMoments.push({
        frame_index: maxHyoidDistanceIndex,
        mask_url: `${BACKEND}/jobs/${jobId}/frames/${maxHyoidDistanceIndex}/mask.png`,
        overlay_url: `${BACKEND}/jobs/${jobId}/frames/${maxHyoidDistanceIndex}/overlay.png`,
        frame_name: "舌骨峰值",
        is_special_moment: true
      });
    }
    
    // 4. 咽腔收缩最大和最小帧
    const maxPharynxIndex = areas.reduce((maxIndex, area, index) => 
      area.pharynx > areas[maxIndex].pharynx ? index : maxIndex, 0
    );
    const minPharynxIndex = areas.reduce((minIndex, area, index) => 
      area.pharynx < areas[minIndex].pharynx ? index : minIndex, 0
    );
    
    specialMoments.push({
      frame_index: maxPharynxIndex,
      mask_url: `${BACKEND}/jobs/${jobId}/frames/${maxPharynxIndex}/mask.png`,
      overlay_url: `${BACKEND}/jobs/${jobId}/frames/${maxPharynxIndex}/overlay.png`,
      frame_name: "咽腔收缩最大",
      is_special_moment: true
    });
    
    specialMoments.push({
      frame_index: minPharynxIndex,
      mask_url: `${BACKEND}/jobs/${jobId}/frames/${minPharynxIndex}/mask.png`,
      overlay_url: `${BACKEND}/jobs/${jobId}/frames/${minPharynxIndex}/overlay.png`,
      frame_name: "咽腔收缩最小",
      is_special_moment: true
    });
    
    // 5. 咽期吞咽结束：bolus和pharynx重合后再次不重合
    if (firstOverlapIndex !== -1) {
      const lastOverlapIndex = areas.findIndex((area, index) => 
        index > firstOverlapIndex && area.bolus_pharynx_overlap === 0
      );
      if (lastOverlapIndex !== -1) {
        specialMoments.push({
          frame_index: lastOverlapIndex,
          mask_url: `${BACKEND}/jobs/${jobId}/frames/${lastOverlapIndex}/mask.png`,
          overlay_url: `${BACKEND}/jobs/${jobId}/frames/${lastOverlapIndex}/overlay.png`,
          frame_name: "咽期吞咽结束",
          is_special_moment: true
        });
      }
    }
    
    return specialMoments;
  }, [summary, jobId]);

  // 计算归一化数据
  const normalizedData = useMemo(() => {
    if (!summary?.signals?.areas) return null;
    
    const areas = summary.signals.areas;
    
    // 1. 计算c2c4_length的中值作为reference
    const validC2C4Lengths = areas
      .map(area => area.c2c4_length)
      .filter(length => length !== null && length > 0);
    
    if (validC2C4Lengths.length === 0) return null;
    
    // 计算中值
    const sortedLengths = [...validC2C4Lengths].sort((a, b) => a! - b!);
    const midIndex = Math.floor(sortedLengths.length / 2);
    const reference = sortedLengths.length % 2 === 0 
      ? (sortedLengths[midIndex - 1]! + sortedLengths[midIndex]!) / 2
      : sortedLengths[midIndex]!;
    
    // 2. 计算归一化数据
    const normalizedAreas = areas.map(area => {
      if (!area.c2c4_length || area.c2c4_length <= 0) {
        return {
          ...area,
          // 距离归一化（平方关系）
          normalized_hyoid_c4_distance: null,
          normalized_ues_length: null,
                  // 面积归一化（线性关系）
        normalized_pharynx: null,
        normalized_vestibule: null,
        normalized_bolus_pharynx_overlap: null,
        normalized_bolus_vestibule_overlap: null
        };
      }
      
      const scaleFactor = reference / area.c2c4_length;
      const scaleFactorSquared = scaleFactor * scaleFactor;
      
      return {
        ...area,
        // 距离归一化（平方关系）
        normalized_hyoid_c4_distance: area.hyoid_c4_distance !== null 
          ? area.hyoid_c4_distance * scaleFactorSquared 
          : null,
        normalized_ues_length: area.ues_length !== null 
          ? area.ues_length * scaleFactorSquared 
          : null,
        // 面积归一化（线性关系）
        normalized_pharynx: area.pharynx * scaleFactor,
        normalized_vestibule: area.vestibule * scaleFactor,
        normalized_bolus_pharynx_overlap: area.bolus_pharynx_overlap * scaleFactor,
        normalized_bolus_vestibule_overlap: area.bolus_vestibule_overlap * scaleFactor
      };
    });
    
    return {
      reference,
      areas: normalizedAreas
    };
  }, [summary]);

  // 创建原始面积变化图表
  const areaChartOption = useMemo(() => {
    const frames = summary?.signals?.areas?.length ?? 0;
    if (!frames) return undefined;
    
    const areas = summary!.signals!.areas;
    const x = Array.from({ length: frames }, (_, i) => i);
    
    // 使用与原来面积图表完全相同的数据处理方式
    const pharynx = areas.map(a => a.pharynx);
    const vestibule = areas.map(a => a.vestibule);
    const bolusPharynxOverlap = areas.map(a => a.bolus_pharynx_overlap);
    const bolusVestibuleOverlap = areas.map(a => a.bolus_vestibule_overlap);

    return {
      title: { 
        text: 'Polygon Area Changes Over Frames',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: { 
        trigger: 'axis',
        formatter: function(params: any) {
          let tooltip = `Frame: ${params[0].axisValue}<br/>`;
          params.forEach((param: any) => {
            tooltip += `${param.seriesName}: ${param.value} px²<br/>`;
          });
          return tooltip;
        }
      },
      legend: { 
        data: ['pharynx', 'vestibule', 'bolus-pharynx overlap', 'bolus-vestibule overlap'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      xAxis: { 
        type: 'category', 
        data: x, 
        name: 'frame',
        axisPointer: {
          value: 0,
          snap: true
        }
      },
      yAxis: {
        type: 'value',
        name: 'Area (px²)',
        nameLocation: 'middle',
        nameGap: 40,
        splitLine: { 
          show: true, 
          lineStyle: { type: 'dashed', color: '#e0e0e0' } 
        },
        axisLine: { lineStyle: { color: '#ff6b6b' } },
        axisTick: { show: true },
        // 优化标签显示，大数值显示为k单位
        axisLabel: {
          formatter: function(value: number) {
            if (value >= 1000) {
              return (value / 1000).toFixed(1) + 'k';
            }
            return value.toString();
          }
        }
      },
      series: [
        { 
          type: 'line', 
          name: 'pharynx', 
          data: pharynx, 
          smooth: true,
          lineStyle: { width: 2, color: '#ff6b6b' },
          itemStyle: { color: '#ff6b6b' }
        },
        { 
          type: 'line', 
          name: 'vestibule', 
          data: vestibule, 
          smooth: true,
          lineStyle: { width: 2, color: '#4ecdc4' },
          itemStyle: { color: '#4ecdc4' }
        },
        { 
          type: 'line', 
          name: 'bolus-pharynx overlap', 
          data: bolusPharynxOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#45b7d1' },
          itemStyle: { color: '#45b7d1' }
        },
        { 
          type: 'line', 
          name: 'bolus-vestibule overlap', 
          data: bolusVestibuleOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#96ceb4' },
          itemStyle: { color: '#96ceb4' }
        }
      ],
      grid: { left: 60, right: 20, top: 120, bottom: 50 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [summary]);

  // 创建归一化后的面积变化图表
  const normalizedAreaChartOption = useMemo(() => {
    if (!normalizedData) return undefined;
    
    const frames = normalizedData.areas.length;
    const x = Array.from({ length: frames }, (_, i) => i);
    
    // 使用归一化后的数据
    const pharynx = normalizedData.areas.map(a => a.normalized_pharynx);
    const vestibule = normalizedData.areas.map(a => a.normalized_vestibule);
    const bolusPharynxOverlap = normalizedData.areas.map(a => a.normalized_bolus_pharynx_overlap);
    const bolusVestibuleOverlap = normalizedData.areas.map(a => a.normalized_bolus_vestibule_overlap);

    return {
      title: { 
        text: 'Normalized Polygon Area Changes Over Frames (C2C4 Length Normalized)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: { 
        trigger: 'axis',
        formatter: function(params: any) {
          let tooltip = `Frame: ${params[0].axisValue}<br/>`;
          tooltip += `Reference C2C4 Length: ${normalizedData.reference.toFixed(2)} px<br/>`;
          params.forEach((param: any) => {
            tooltip += `${param.seriesName}: ${param.value.toFixed(2)} normalized px²<br/>`;
          });
          return tooltip;
        }
      },
      legend: { 
        data: ['Normalized pharynx', 'Normalized vestibule', 'Normalized bolus-pharynx overlap', 'Normalized bolus-vestibule overlap'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      xAxis: { 
        type: 'category', 
        data: x, 
        name: 'frame',
        axisPointer: {
          value: 0,
          snap: true
        }
      },
      yAxis: {
        type: 'value',
        name: 'Normalized Area (px²)',
        nameLocation: 'middle',
        nameGap: 40,
        splitLine: { 
          show: true, 
          lineStyle: { type: 'dashed', color: '#e0e0e0' } 
        },
        axisLine: { lineStyle: { color: '#ff6b6b' } },
        axisTick: { show: true },
        // 优化标签显示，大数值显示为k单位
        axisLabel: {
          formatter: function(value: number) {
            if (value >= 1000) {
              return (value / 1000).toFixed(1) + 'k';
            }
            return value.toString();
          }
        }
      },
      series: [
        { 
          type: 'line', 
          name: 'Normalized pharynx', 
          data: pharynx, 
          smooth: true,
          lineStyle: { width: 2, color: '#ff6b6b' },
          itemStyle: { color: '#ff6b6b' }
        },
        { 
          type: 'line', 
          name: 'Normalized vestibule', 
          data: vestibule, 
          smooth: true,
          lineStyle: { width: 2, color: '#4ecdc4' },
          itemStyle: { color: '#4ecdc4' }
        },
        { 
          type: 'line', 
          name: 'Normalized bolus-pharynx overlap', 
          data: bolusPharynxOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#45b7d1' },
          itemStyle: { color: '#45b7d1' }
        },
        { 
          type: 'line', 
          name: 'Normalized bolus-vestibule overlap', 
          data: bolusVestibuleOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#96ceb4' },
          itemStyle: { color: '#96ceb4' }
        }
      ],
      grid: { left: 60, right: 20, top: 120, bottom: 50 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [normalizedData]);

  // 创建归一化后的Hyoid距离和UES长度组合图表
  const normalizedHyoidDistanceChartOption = useMemo(() => {
    if (!normalizedData) return undefined;
    
    const areas = normalizedData.areas;
    const frames = Array.from({ length: areas.length }, (_, i) => i);
    const hyoidDistances = areas.map(area => area.normalized_hyoid_c4_distance);
    const uesLengths = areas.map(area => area.normalized_ues_length);
    
    // 过滤掉无效数据
    const validHyoidData = frames
      .map((frame, idx) => ({ frame, distance: hyoidDistances[idx] }))
      .filter(item => item.distance !== null);
    
    const validUesData = frames
      .map((frame, idx) => ({ frame, length: uesLengths[idx] }))
      .filter(item => item.length !== null);

    if (!validHyoidData.length || !validUesData.length) return undefined;

    // 计算归一化后的数据范围
    const distances = validHyoidData.map(item => item.distance!);
    const minDistance = Math.min(...distances);
    const maxDistance = Math.max(...distances);
    const distanceRange = maxDistance - minDistance;
    
    const lengths = validUesData.map(item => item.length!);
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);
    const lengthRange = maxLength - minLength;
    
    // 计算优化的Y轴范围
    let hyoidYMin, hyoidYMax;
    if (distanceRange <= 10) {
      const padding = Math.max(1, distanceRange * 0.3);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    } else if (distanceRange <= 50) {
      const padding = Math.max(2, distanceRange * 0.2);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    } else {
      const padding = Math.max(5, distanceRange * 0.1);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    }
    
    let uesYMin, uesYMax;
    if (lengthRange <= 5) {
      const padding = Math.max(2, lengthRange * 0.8);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else if (lengthRange <= 15) {
      const padding = Math.max(1.5, lengthRange * 0.4);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else if (lengthRange <= 30) {
      const padding = Math.max(1, lengthRange * 0.25);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else {
      const padding = Math.max(0.5, lengthRange * 0.15);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    }

    return {
      title: { 
        text: 'Normalized Hyoid Distances & UES Length (C2C4 Length Normalized)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: { 
        trigger: 'axis',
        axisPointer: {
          type: 'cross'
        },
        formatter: function(params: any) {
          let tooltip = `Frame: ${params[0].axisValue}<br/>`;
          tooltip += `Reference C2C4 Length: ${normalizedData.reference.toFixed(2)} px<br/>`;
          params.forEach((param: any) => {
            if (param.seriesName.includes('Length')) {
              tooltip += `${param.seriesName}: ${param.value?.toFixed(2)} normalized px<br/>`;
            } else {
              tooltip += `${param.seriesName}: ${param.value?.toFixed(2)} normalized px<br/>`;
            }
          });
          return tooltip;
        }
      },
      legend: { 
        data: ['Normalized Hyoid-C4 Distance', 'Normalized UES Length'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      xAxis: { 
        type: 'category', 
        data: frames, 
        name: 'frame',
        axisPointer: {
          value: 0,
          snap: true
        }
      },
      yAxis: [
        {
          type: 'value',
          name: 'Normalized Hyoid-C4 Distance (px)',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'left',
          min: hyoidYMin,
          max: hyoidYMax,
          splitLine: { 
            show: true, 
            lineStyle: { type: 'dashed', color: '#e0e0e0' } 
          },
          axisLine: { lineStyle: { color: '#9c88ff' } },
          axisTick: { show: true }
        },
        {
          type: 'value',
          name: 'Normalized UES Length (px)',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'right',
          min: uesYMin,
          max: uesYMax,
          splitLine: { show: false },
          axisLine: { lineStyle: { color: '#ff9ff3' } },
          axisTick: { show: true },
          axisLabel: {
            formatter: function(value: number) {
              return value.toFixed(1);
            }
          }
        }
      ],
      series: [
        { 
          type: 'line', 
          name: 'Normalized Hyoid-C4 Distance', 
          data: hyoidDistances, 
          smooth: true,
          lineStyle: { width: 3, color: '#9c88ff' },
          itemStyle: { color: '#9c88ff' },
          yAxisIndex: 0,
          symbol: 'circle',
          symbolSize: function(value: any, params: any) {
            const distance = value;
            if (distance === minDistance || distance === maxDistance) {
              return 8;
            }
            return 4;
          },
          label: {
            show: false,
            position: 'top',
            formatter: function(params: any) {
              const distance = params.value;
              if (distance === minDistance || distance === maxDistance) {
                return distance.toFixed(1);
              }
              return '';
            },
            fontSize: 12,
            color: '#666'
          }
        },
        { 
          type: 'line', 
          name: 'Normalized UES Length', 
          data: uesLengths, 
          smooth: true,
          lineStyle: { width: 3, color: '#ff9ff3' },
          itemStyle: { color: '#ff9ff3' },
          yAxisIndex: 1,
          symbol: 'circle',
          symbolSize: function(value: any, params: any) {
            const length = value;
            if (length === minLength || length === maxLength) {
              return 8;
            }
            return 4;
            },
          label: {
            show: false,
            position: 'top',
            formatter: function(params: any) {
              const length = params.value;
              if (length === minLength || length === maxLength) {
                return length.toFixed(1);
              }
              return '';
            },
            fontSize: 12,
            color: '#666'
          }
        }
      ],
      grid: { left: 60, right: 60, top: 120, bottom: 50 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [normalizedData]);

  // 创建原始Hyoid距离和UES长度组合图表
  const hyoidDistanceChartOption = useMemo(() => {
    const areas = summary?.signals?.areas ?? [];
    if (!areas.length) return undefined;
    
    const frames = Array.from({ length: areas.length }, (_, i) => i);
    const hyoidDistances = areas.map(area => area.hyoid_c4_distance);
    const uesLengths = areas.map(area => area.ues_length);
    
    // 过滤掉无效数据
    const validHyoidData = frames
      .map((frame, idx) => ({ frame, distance: hyoidDistances[idx] }))
      .filter(item => item.distance !== null);
    
    const validUesData = frames
      .map((frame, idx) => ({ frame, length: uesLengths[idx] }))
      .filter(item => item.length !== null);

    if (!validHyoidData.length || !validUesData.length) return undefined;

    // 计算Hyoid距离范围，用于优化左Y轴显示
    const distances = validHyoidData.map(item => item.distance!);
    const minDistance = Math.min(...distances);
    const maxDistance = Math.max(...distances);
    const distanceRange = maxDistance - minDistance;
    
    // 计算UES长度范围，用于优化右Y轴显示
    const lengths = validUesData.map(item => item.length!);
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);
    const lengthRange = maxLength - minLength;
    
    // 计算优化的Y轴范围
    let hyoidYMin, hyoidYMax;
    if (distanceRange <= 10) {
      const padding = Math.max(1, distanceRange * 0.3);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    } else if (distanceRange <= 50) {
      const padding = Math.max(2, distanceRange * 0.2);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    } else {
      const padding = Math.max(5, distanceRange * 0.1);
      hyoidYMin = Math.max(0, minDistance - padding);
      hyoidYMax = maxDistance + padding;
    }
    
    let uesYMin, uesYMax;
    if (lengthRange <= 5) {
      const padding = Math.max(2, lengthRange * 0.8);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else if (lengthRange <= 15) {
      const padding = Math.max(1.5, lengthRange * 0.4);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else if (lengthRange <= 30) {
      const padding = Math.max(1, lengthRange * 0.25);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    } else {
      const padding = Math.max(0.5, lengthRange * 0.15);
      uesYMin = Math.max(0, minLength - padding);
      uesYMax = maxLength + padding;
    }

    return {
      title: { 
        text: 'Hyoid Distances & UES Length (Relative Coordinates)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 18, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: { 
        trigger: 'axis',
        axisPointer: {
          type: 'cross'
        },
        formatter: function(params: any) {
          let tooltip = `Frame: ${params[0].axisValue}<br/>`;
          params.forEach((param: any) => {
            if (param.seriesName.includes('Length')) {
              tooltip += `${param.seriesName}: ${param.value?.toFixed(2)} px<br/>`;
            } else {
              tooltip += `${param.seriesName}: ${param.value?.toFixed(2)} px<br/>`;
            }
          });
          return tooltip;
        }
      },
      legend: { 
        data: ['Hyoid-C4 Distance', 'UES Length'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      xAxis: { 
        type: 'category', 
        data: frames, 
        name: 'frame',
        axisPointer: {
          value: 0,
          snap: true
        }
      },
      yAxis: [
        {
          type: 'value',
          name: 'Hyoid-C4 Distance (px)',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'left',
          min: hyoidYMin,
          max: hyoidYMax,
          splitLine: { 
            show: true, 
            lineStyle: { type: 'dashed', color: '#e0e0e0' } 
          },
          axisLine: { lineStyle: { color: '#9c88ff' } },
          axisTick: { show: true }
        },
        {
          type: 'value',
          name: 'UES Length (px)',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'right',
          min: uesYMin,
          max: uesYMax,
          splitLine: { show: false },
          axisLine: { lineStyle: { color: '#ff9ff3' } },
          axisTick: { show: true },
          axisLabel: {
            formatter: function(value: number) {
              return value.toFixed(1);
            }
          }
        }
      ],
      series: [
        { 
          type: 'line', 
          name: 'Hyoid-C4 Distance', 
          data: hyoidDistances, 
          smooth: true,
          lineStyle: { width: 3, color: '#9c88ff' },
          itemStyle: { color: '#9c88ff' },
          yAxisIndex: 0,
          symbol: 'circle',
          symbolSize: function(value: any, params: any) {
            const distance = value;
            if (distance === minDistance || distance === maxDistance) {
              return 8;
            }
            return 4;
          },
          label: {
            show: false,
            position: 'top',
            formatter: function(params: any) {
              const distance = params.value;
              if (distance === minDistance || distance === maxDistance) {
                return distance.toFixed(1);
              }
              return '';
            },
            fontSize: 12,
            color: '#666'
          }
        },
        { 
          type: 'line', 
          name: 'UES Length', 
          data: uesLengths, 
          smooth: true,
          lineStyle: { width: 3, color: '#ff9ff3' },
          itemStyle: { color: '#ff9ff3' },
          yAxisIndex: 1,
          symbol: 'circle',
          symbolSize: function(value: any, params: any) {
            const length = value;
            if (length === minLength || length === maxLength) {
              return 8;
            }
            return 4;
          },
          label: {
            show: false,
            position: 'top',
            formatter: function(params: any) {
              const length = params.value;
              if (length === minLength || length === maxLength) {
                return length.toFixed(1);
              }
              return '';
            },
            fontSize: 12,
            color: '#666'
          }
        }
      ],
      grid: { left: 60, right: 60, top: 120, bottom: 50 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [summary]);

  // 创建高级分析的综合参数图表（面积和长度/距离在同一尺度上）
  const advancedComprehensiveChartOption = useMemo(() => {
    if (!advancedData) return undefined;
    
    const frames = advancedData.processedData.length;
    const x = Array.from({ length: frames }, (_, i) => i);
    
    // 使用Z-score标准化后的数据（所有参数都在同一尺度上）
    const pharynx = advancedData.processedData.map((a: any) => a.zscore_pharynx);
    const vestibule = advancedData.processedData.map((a: any) => a.zscore_vestibule);
    const bolusPharynxOverlap = advancedData.processedData.map((a: any) => a.zscore_bolus_pharynx_overlap);
    const bolusVestibuleOverlap = advancedData.processedData.map((a: any) => a.zscore_bolus_vestibule_overlap);
    const hyoidDistance = advancedData.processedData.map((a: any) => a.zscore_hyoid_c4_distance);
    const uesLength = advancedData.processedData.map((a: any) => a.zscore_ues_length);

    return {
      title: { 
        text: 'Advanced Analysis: Z-Score Standardized Parameters (Dual Y-Axis)',
        left: 'center',
        top: 10,
        textStyle: { fontSize: 16, fontWeight: 'bold' },
        itemGap: 20
      },
      tooltip: { 
        trigger: 'axis',
        axisPointer: {
          type: 'cross'
        },
        formatter: function(params: any) {
          let tooltip = `Frame: ${params[0].axisValue}<br/>`;
          tooltip += `Reference C2C4 Length: ${advancedData.reference.toFixed(2)} px<br/>`;
          tooltip += `Area Group - Mean: ${advancedData.areaStats.mean.toFixed(2)}, StdDev: ${advancedData.areaStats.stdDev.toFixed(2)}<br/>`;
          tooltip += `Distance Group - Mean: ${advancedData.distanceStats.mean.toFixed(2)}, StdDev: ${advancedData.distanceStats.stdDev.toFixed(2)}<br/>`;
          params.forEach((param: any) => {
            tooltip += `${param.seriesName}: ${param.value?.toFixed(2)} Z-score units<br/>`;
          });
          return tooltip;
        }
      },
      legend: { 
        data: ['Z-Score pharynx', 'Z-Score vestibule', 'Z-Score bolus-pharynx overlap', 'Z-Score bolus-vestibule overlap', 'Z-Score hyoid-c4 distance', 'Z-Score UES length'],
        top: 60,
        itemGap: 20,
        textStyle: { fontSize: 12 }
      },
      xAxis: { 
        type: 'category', 
        data: x, 
        name: 'frame',
        axisPointer: {
          value: 0,
          snap: true
        }
      },
      yAxis: [
        {
          type: 'value',
          name: 'Area Parameters Z-Score',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'left',
          splitLine: { 
            show: true, 
            lineStyle: { type: 'dashed', color: '#e0e0e0' } 
          },
          axisLine: { lineStyle: { color: '#ff6b6b' } },
          axisTick: { show: true },
          axisLabel: {
            formatter: function(value: number) {
              return value.toFixed(1);
            }
          }
        },
        {
          type: 'value',
          name: 'Distance/Length Parameters Z-Score',
          nameLocation: 'middle',
          nameGap: 40,
          position: 'right',
          splitLine: { show: false },
          axisLine: { lineStyle: { color: '#9c88ff' } },
          axisTick: { show: true },
          axisLabel: {
            formatter: function(value: number) {
              return value.toFixed(1);
            }
          }
        }
      ],
      series: [
        { 
          type: 'line', 
          name: 'Z-Score pharynx', 
          data: pharynx, 
          smooth: true,
          lineStyle: { width: 2, color: '#ff6b6b' },
          itemStyle: { color: '#ff6b6b' },
          yAxisIndex: 0
        },
        { 
          type: 'line', 
          name: 'Z-Score vestibule', 
          data: vestibule, 
          smooth: true,
          lineStyle: { width: 2, color: '#4ecdc4' },
          itemStyle: { color: '#4ecdc4' },
          yAxisIndex: 0
        },
        { 
          type: 'line', 
          name: 'Z-Score bolus-pharynx overlap', 
          data: bolusPharynxOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#45b7d1' },
          itemStyle: { color: '#45b7d1' },
          yAxisIndex: 0
        },
        { 
          type: 'line', 
          name: 'Z-Score bolus-vestibule overlap', 
          data: bolusVestibuleOverlap, 
          smooth: true,
          lineStyle: { width: 2, type: 'dashed', color: '#96ceb4' },
          itemStyle: { color: '#96ceb4' },
          yAxisIndex: 0
        },
        { 
          type: 'line', 
          name: 'Z-Score hyoid-c4 distance', 
          data: hyoidDistance, 
          smooth: true,
          lineStyle: { width: 3, color: '#9c88ff' },
          itemStyle: { color: '#9c88ff' },
          yAxisIndex: 1
        },
        { 
          type: 'line', 
          name: 'Z-Score UES length', 
          data: uesLength, 
          smooth: true,
          lineStyle: { width: 3, color: '#ff9ff3' },
          itemStyle: { color: '#ff9ff3' },
          yAxisIndex: 1
        }
      ],
      grid: { left: 60, right: 60, top: 120, bottom: 50 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        }
      ],
      toolbox: {
        feature: {
          dataZoom: { title: 'Zoom' },
          restore: { title: 'Restore' },
          saveAsImage: { title: 'Save' }
        },
        right: 20,
        top: 20,
        itemSize: 16,
        itemGap: 8
      }
    };
  }, [advancedData]);



  return (
    <div style={{ 
      width: '100%', 
      minHeight: '100vh',
      margin: '0 auto', 
      fontFamily: 'system-ui, sans-serif',
      padding: '20px',
      boxSizing: 'border-box'
    }}>
      <h2 style={{ textAlign: 'center', marginBottom: '30px' }}>VFSS Analysis Frontend</h2>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr 1fr', alignItems: 'end' }}>
        <div>
          <label>Video file</label>
          <input type="file" accept="video/*" onChange={e => setFile(e.target.files?.[0] || null)} />
        </div>
        <div>
          <label>poly_thresh</label>
          <input type="number" step="0.05" min={0} max={1} value={polyThresh}
                 onChange={e => setPolyThresh(parseFloat(e.target.value))} />
        </div>
        <div>
          <label>point_thresh</label>
          <input type="number" step="0.05" min={0} max={1} value={pointThresh}
                 onChange={e => setPointThresh(parseFloat(e.target.value))} />
        </div>
        <div>
          <label>point_radius</label>
          <input type="number" min={1} max={50} value={pointRadius}
                 onChange={e => setPointRadius(parseInt(e.target.value || '6', 10))} />
        </div>
        <div>
          <button disabled={submitting} onClick={onSubmit}>Submit</button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div>Backend: {BACKEND}</div>
        <div>Job: {jobId || '-'}</div>
        <div>Status: {jobStatus || '-'}</div>
      </div>

      {summary && (
        <>
          <div style={{ marginTop: 20 }}>
            <button onClick={downloadCsv}>Download signals.csv</button>
          </div>

          {/* 数据统计面板 - 全屏显示 */}
          <div style={{ 
            marginTop: 20, 
            padding: '16px', 
            border: '1px solid #ddd', 
            borderRadius: '8px',
            backgroundColor: '#f9f9f9',
            width: '100%'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, color: '#333' }}>Analysis Summary</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '14px', color: '#666' }}>Data Display:</span>
                <button 
                  onClick={() => setShowNormalized(false)}
                  style={{
                    padding: '6px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: !showNormalized ? '#007bff' : '#e9ecef',
                    color: !showNormalized ? 'white' : '#666',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  Original
                </button>
                <button 
                  onClick={() => setShowNormalized(true)}
                  style={{
                    padding: '6px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: showNormalized ? '#28a745' : '#e9ecef',
                    color: showNormalized ? 'white' : '#666',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  Normalized
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div>
                <strong>Total Frames:</strong> {summary.frames}
              </div>
              <div>
                <strong>Video FPS:</strong> {summary.fps || 'Unknown'} FPS
              </div>
              <div>
                <strong>Coordinate System Valid:</strong> 
                <span style={{ color: summary.signals?.areas?.some(a => a.coordinate_system_valid) ? '#28a745' : '#dc3545' }}>
                  {summary.signals?.areas?.some(a => a.coordinate_system_valid) ? 'Yes' : 'No'}
                </span>
              </div>
              <div>
                <strong>Bolus Tracking:</strong> 
                <span style={{ color: summary.signals?.areas?.some(a => a.bolus_track_valid) ? '#28a745' : '#dc3545' }}>
                  {summary.signals?.areas?.some(a => a.bolus_track_valid) ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div>
                <strong>Valid Hyoid Data:</strong> 
                {summary.signals?.areas?.filter(a => a.hyoid_relative_x !== null && a.hyoid_relative_y !== null).length || 0} / {summary.frames}
              </div>
              <div>
                <strong>Valid UES Length Data:</strong> 
                {summary.signals?.areas?.filter(a => a.ues_length !== null).length || 0} / {summary.frames}
              </div>
              {showNormalized && normalizedData && (
                <>
                  <div>
                    <strong>Reference C2C4 Length:</strong> {normalizedData.reference.toFixed(2)} px
                  </div>
                  <div>
                    <strong>Normalization Status:</strong> 
                    <span style={{ color: '#28a745' }}>Active</span>
                  </div>
                  <div>
                    <strong>Valid C2C4 Data:</strong> 
                    {summary.signals?.areas?.filter(a => a.c2c4_length !== null && a.c2c4_length > 0).length || 0} / {summary.frames}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 特殊时刻帧展示 - 全屏显示 */}
          <div style={{ marginTop: 24, width: '100%' }}>
            <h3 style={{ margin: '0 0 16px 0', color: '#333', textAlign: 'center' }}>
              Special Moment Frames Analysis
            </h3>
            <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', width: '100%' }}>
              {/* 特殊时刻帧展示 */}
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: '20px',
                width: 'calc(100% - 274px)'
              }}>
                {calculateSpecialMoments.map((moment, index) => {
                  const fps = summary.fps || 30;
                  const timeInSeconds = moment.frame_index / fps;
                  const minutes = Math.floor(timeInSeconds / 60);
                  const seconds = (timeInSeconds % 60).toFixed(2);
                  const timeString = `${minutes}:${seconds.padStart(5, '0')}`;
                  
                  return (
                    <div key={index} style={{ 
                      border: '2px solid #4ecdc4', 
                      borderRadius: '12px',
                      padding: '16px',
                      backgroundColor: '#f8f9fa',
                      textAlign: 'center',
                      boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
                      minHeight: '350px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between'
                    }}>
                      <div style={{ 
                        fontSize: '16px', 
                        fontWeight: 'bold', 
                        marginBottom: '12px',
                        padding: '10px',
                        backgroundColor: '#4ecdc4',
                        color: 'white',
                        borderRadius: '6px'
                      }}>
                        {moment.frame_name}
                      </div>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {moment.overlay_url ? (
                          <img 
                            src={moment.overlay_url} 
                            width="100%" 
                            height="auto"
                            style={{ 
                              borderRadius: '8px', 
                              border: '1px solid #ddd',
                              maxWidth: '300px'
                            }}
                            alt={`Frame ${moment.frame_index}`}
                          />
                        ) : (
                          <div style={{ 
                            width: '100%', 
                            maxWidth: '300px',
                            height: '300px',
                            backgroundColor: '#e9ecef',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '8px',
                            border: '1px solid #ddd'
                          }}>
                            No overlay
                          </div>
                        )}
                      </div>
                      <div style={{ 
                        marginTop: '12px',
                        fontSize: '13px',
                        color: '#6c757d',
                        fontFamily: 'monospace',
                        padding: '8px',
                        backgroundColor: '#e9ecef',
                        borderRadius: '6px'
                      }}>
                        可见第{moment.frame_index}帧 - {timeString}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* 颜色图例说明 */}
              <div style={{ 
                width: '250px',
                padding: '20px',
                backgroundColor: '#f8f9fa',
                borderRadius: '12px',
                border: '2px solid #e9ecef',
                position: 'sticky',
                top: '20px',
                height: 'fit-content',
                flexShrink: 0
              }}>
                <h4 style={{ 
                  margin: '0 0 20px 0', 
                  color: '#333',
                  textAlign: 'center',
                  fontSize: '18px',
                  fontWeight: 'bold'
                }}>
                  ROI颜色说明
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* 点类ROI */}
                  <div>
                    <div style={{ 
                      fontSize: '15px', 
                      fontWeight: 'bold', 
                      color: '#2c3e50',
                      marginBottom: '12px',
                      borderBottom: '2px solid #dee2e6',
                      paddingBottom: '6px'
                    }}>
                      点类标记
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#ff0000', 
                          borderRadius: '50%',
                          border: '2px solid #fff',
                          boxShadow: '0 0 0 1px #000'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>UESout (红色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#00ff00', 
                          borderRadius: '50%',
                          border: '2px solid #fff',
                          boxShadow: '0 0 0 1px #000'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>UESin (绿色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#0000ff', 
                          borderRadius: '50%',
                          border: '2px solid #fff',
                          boxShadow: '0 0 0 1px #000'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>C2 (蓝色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#00ffff', 
                          borderRadius: '50%',
                          border: '2px solid #fff',
                          boxShadow: '0 0 0 1px #000'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>C4 (黄色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#ff00ff', 
                          borderRadius: '50%',
                          border: '2px solid #fff',
                          boxShadow: '0 0 0 1px #000'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>hyoid (紫色)</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* 多边形类ROI */}
                  <div>
                    <div style={{ 
                      fontSize: '15px', 
                      fontWeight: 'bold', 
                      color: '#2c3e50',
                      marginBottom: '12px',
                      borderBottom: '2px solid #dee2e6',
                      paddingBottom: '6px'
                    }}>
                      多边形区域
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#ffff00', 
                          borderRadius: '2px'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>pharynx (青色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#ff8000', 
                          borderRadius: '2px'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>vestibule (橙色)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ 
                          width: '18px', 
                          height: '18px', 
                          backgroundColor: '#ff0080', 
                          borderRadius: '2px'
                        }}></div>
                        <span style={{ fontSize: '13px' }}>bolus (粉色)</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* 说明文字 */}
                  <div style={{ 
                    fontSize: '12px', 
                    color: '#6c757d',
                    fontStyle: 'italic',
                    textAlign: 'center',
                    padding: '10px',
                    backgroundColor: '#e9ecef',
                    borderRadius: '6px',
                    marginTop: '12px'
                  }}>
                    颜色对应后端LABEL_COLORS_BGR定义
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 三个图表 - 居中显示且宽度为屏幕的一半 */}
          <div style={{ marginTop: 24 }}>
            {/* 调试信息 */}
            <div style={{ 
              marginBottom: '10px', 
              padding: '10px', 
              backgroundColor: '#f0f0f0', 
              borderRadius: '4px',
              fontSize: '12px',
              fontFamily: 'monospace'
            }}>
              调试信息: showNormalized={showNormalized.toString()}, 
              areaChartOption={areaChartOption ? '存在' : '不存在'}, 
              normalizedAreaChartOption={normalizedAreaChartOption ? '存在' : '不存在'},
              summary={summary ? '存在' : '不存在'},
              summary.signals={summary?.signals ? '存在' : '不存在'},
              summary.signals.areas={summary?.signals?.areas ? `存在(${summary.signals.areas.length}帧)` : '不存在'}
            </div>
            {showNormalized ? (
              // 显示归一化图表
              normalizedAreaChartOption && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: '50%', minWidth: '600px' }}>
                    <ReactECharts option={normalizedAreaChartOption} style={{ height: 500 }} />
                  </div>
                </div>
              )
            ) : (
              // 显示原始图表
              areaChartOption && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: '50%', minWidth: '600px' }}>
                    <ReactECharts option={areaChartOption} style={{ height: 500 }} />
                  </div>
                </div>
              )
            )}
          </div>
          <div style={{ marginTop: 24 }}>
            {showNormalized ? (
              // 显示归一化图表
              normalizedHyoidDistanceChartOption && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: '50%', minWidth: '600px' }}>
                    <ReactECharts option={normalizedHyoidDistanceChartOption} style={{ height: 360 }} />
                  </div>
                </div>
              )
            ) : (
              // 显示原始图表
              hyoidDistanceChartOption && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: '50%', minWidth: '600px' }}>
                    <ReactECharts option={hyoidDistanceChartOption} style={{ height: 360 }} />
                  </div>
                </div>
              )
            )}
          </div>
          <div style={{ marginTop: 24 }}>
            {bolusTrajectoryChartOption && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: '50%', minWidth: '600px' }}>
                  <ReactECharts option={bolusTrajectoryChartOption} style={{ height: 360 }} />
                </div>
              </div>
            )}
          </div>
          <div style={{ marginTop: 24 }}>
            {hyoidChartOption && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: '50%', minWidth: '600px' }}>
                  <ReactECharts option={hyoidChartOption} style={{ height: 360 }} />
                </div>
              </div>
            )}
          </div>

          {/* 高级分析询问区域 */}
          {!showAdvancedAnalysis && summary && (
            <div style={{ 
              marginTop: 40, 
              padding: '30px', 
              border: '2px solid #28a745', 
              borderRadius: '12px',
              backgroundColor: '#f8fff9',
              textAlign: 'center',
              width: '100%'
            }}>
              <h3 style={{ 
                margin: '0 0 20px 0', 
                color: '#28a745',
                fontSize: '24px',
                fontWeight: 'bold'
              }}>
                 基础分析已完成！
              </h3>
              <p style={{ 
                margin: '0 0 25px 0', 
                color: '#666',
                fontSize: '16px',
                lineHeight: '1.6'
              }}>
                已完成对原始数据的分析，包括视频分帧、模型推理、特殊帧展示和运动曲线等基础功能。
                <br />
                <strong>是否需要进一步的数据处理和定量分析？</strong>
              </p>
              
              {/* 错误信息显示 */}
              {advancedAnalysisError && (
                <div style={{ 
                  marginBottom: '20px',
                  padding: '15px',
                  backgroundColor: '#f8d7da',
                  border: '1px solid #f5c6cb',
                  borderRadius: '8px',
                  color: '#721c24',
                  fontSize: '14px'
                }}>
                  <strong>⚠️ 高级分析失败:</strong> {advancedAnalysisError}
                  <br />
                  <button 
                    onClick={() => {
                      setAdvancedAnalysisError(null);
                      // 确保清除错误后基础图表能正常显示
                      console.log('清除错误信息，当前summary状态:', summary);
                    }}
                    style={{
                      marginTop: '10px',
                      padding: '5px 10px',
                      border: 'none',
                      borderRadius: '4px',
                      backgroundColor: '#dc3545',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                  >
                    清除错误信息
                  </button>
                </div>
              )}
              
              <div style={{ display: 'flex', justifyContent: 'center', gap: '20px' }}>
                <button 
                  onClick={handleAdvancedAnalysis}
                  disabled={processingAdvanced}
                  style={{
                    padding: '15px 30px',
                    border: 'none',
                    borderRadius: '8px',
                    backgroundColor: '#28a745',
                    color: 'white',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    cursor: processingAdvanced ? 'not-allowed' : 'pointer',
                    opacity: processingAdvanced ? 0.6 : 1,
                    transition: 'all 0.3s ease'
                  }}
                >
                  {processingAdvanced ? '🔄 处理中...' : '✅ 是，继续高级分析'}
                </button>
                <button 
                  style={{
                    padding: '15px 30px',
                    border: '2px solid #6c757d',
                    borderRadius: '8px',
                    backgroundColor: 'transparent',
                    color: '#6c757d',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease'
                  }}
                >
                  ❌ 否，到此结束
                </button>
              </div>
              <div style={{ 
                marginTop: '20px',
                fontSize: '14px',
                color: '#888',
                fontStyle: 'italic'
              }}>
                高级分析将包括：Savitzky-Golay平滑滤波 + C2C4归一化 + 分组Z-score标准化（保持各参数类型的相对变化幅度）
              </div>
            </div>
          )}

          {/* 高级分析结果展示 */}
          {showAdvancedAnalysis && advancedData && (
            <>
              <div style={{ 
                marginTop: 40, 
                padding: '20px', 
                border: '2px solid #007bff', 
                borderRadius: '12px',
                backgroundColor: '#f0f8ff',
                textAlign: 'center',
                width: '100%'
              }}>
                <h3 style={{ 
                  margin: '0 0 15px 0', 
                  color: '#007bff',
                  fontSize: '22px',
                  fontWeight: 'bold'
                }}>
                   高级分析完成！
                </h3>
                <p style={{ 
                  margin: '0 0 15px 0', 
                  color: '#666',
                  fontSize: '14px'
                }}>
                  已应用Savitzky-Golay平滑滤波（2阶）、C2C4长度归一化和Z-score标准化处理
                  <br />
                  Reference C2C4 Length: <strong>{advancedData.reference.toFixed(2)} px</strong>
                  <br />
                  Area Group - Mean: <strong>{advancedData.areaStats.mean.toFixed(2)}</strong>, StdDev: <strong>{advancedData.areaStats.stdDev.toFixed(2)}</strong><br />
                  Distance Group - Mean: <strong>{advancedData.distanceStats.mean.toFixed(2)}</strong>, StdDev: <strong>{advancedData.distanceStats.stdDev.toFixed(2)}</strong>
                </p>
                <button 
                  onClick={() => generateAdvancedCSV(advancedData)}
                  style={{
                    padding: '10px 20px',
                    border: 'none',
                    borderRadius: '6px',
                    backgroundColor: '#007bff',
                    color: 'white',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                   下载高级分析CSV
                </button>
              </div>

              {/* 高级分析图表 - 放在上面 */}
              <div style={{ marginTop: 24 }}>
                {advancedComprehensiveChartOption && (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: '50%', minWidth: '600px' }}>
                      <ReactECharts option={advancedComprehensiveChartOption} style={{ height: 500 }} />
                    </div>
                  </div>
                )}
              </div>

              {/* 调试信息面板 */}
              <div style={{ 
                marginTop: 24, 
                padding: '20px', 
                border: '2px solid #ffc107', 
                borderRadius: '12px',
                backgroundColor: '#fff3cd',
                width: '100%'
              }}>
                <h4 style={{ 
                  margin: '0 0 15px 0', 
                  color: '#856404',
                  fontSize: '16px',
                  fontWeight: 'bold'
                }}>
                   调试信息
                </h4>
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
                  gap: '16px',
                  fontSize: '12px',
                  fontFamily: 'monospace'
                }}>
                  <div>
                    <strong>高级数据状态:</strong><br/>
                    processedData: {advancedData?.processedData ? `${advancedData.processedData.length} 帧` : 'null'}<br/>
                    reference: {advancedData?.reference ? advancedData.reference.toFixed(2) : 'null'}<br/>
                    areaStats: {advancedData?.areaStats ? `均值=${advancedData.areaStats.mean.toFixed(2)}, 标准差=${advancedData.areaStats.stdDev.toFixed(2)}` : 'null'}
                  </div>
                  <div>
                    <strong>吞咽分析状态:</strong><br/>
                    swallowingAnalysis: {advancedData?.swallowingAnalysis ? '存在' : 'null'}<br/>
                    totalSwallows: {advancedData?.swallowingAnalysis?.totalSwallows || 'N/A'}<br/>
                    cycles: {advancedData?.swallowingAnalysis?.cycles ? `${advancedData.swallowingAnalysis.cycles.length} 个周期` : 'N/A'}
                  </div>
                  <div>
                    <strong>Z-score数据样本:</strong><br/>
                    {advancedData?.processedData ? 
                      `前5帧: ${advancedData.processedData.slice(0, 5).map((row: any) => row.zscore_bolus_pharynx_overlap?.toFixed(3)).join(', ')}` : 
                      'N/A'
                    }
                  </div>
                  <div>
                    <strong>峰值检测:</strong><br/>
                    peaks: {advancedData?.swallowingAnalysis?.peaks ? `${advancedData.swallowingAnalysis.peaks.length} 个峰值` : 'N/A'}<br/>
                    smoothedData: {advancedData?.swallowingAnalysis?.smoothedData ? `${advancedData.swallowingAnalysis.smoothedData.length} 帧` : 'N/A'}
                  </div>
                  <div>
                    <strong>基线信息:</strong><br/>
                    {advancedData?.swallowingAnalysis?.smoothedData ? 
                      `全局最低值: ${Math.min(...advancedData.swallowingAnalysis.smoothedData).toFixed(3)}` : 'N/A'}<br/>
                    {advancedData?.swallowingAnalysis?.smoothedData ? 
                      `全局最高值: ${Math.max(...advancedData.swallowingAnalysis.smoothedData).toFixed(3)}` : 'N/A'}
                  </div>
                  <div>
                    <strong>周期连续性:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.startFrame}→${cycle.endFrame}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>医学参数状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: PCR=${cycle.PCR?.toFixed(3) || 'N/A'}${cycle.PCR_hasNegativeValues ? '(已处理负值)' : ''}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>误吸误咽状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.aspirationRisk ? '⚠️有风险' : '✅无风险'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>HYB状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.HYB || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>UESmax状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.UES_peakFrame || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>UESO状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.UESO || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>UESC状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.UESC || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>LVC状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.LVC || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                  <div>
                    <strong>LVCoff状态:</strong><br/>
                    {advancedData?.swallowingAnalysis?.cycles ? 
                      advancedData.swallowingAnalysis.cycles.map((cycle: any, idx: number) => 
                        `周期${cycle.cycleNumber}: ${cycle.LVCoff || 'N/A'}`
                      ).join(', ') : 'N/A'}
                  </div>
                </div>
              </div>

              {/* 吞咽周期分析表格 - 放在下面 */}
              {advancedData.swallowingAnalysis && (
                <div style={{ 
                  marginTop: 24, 
                  padding: '20px', 
                  border: '2px solid #28a745', 
                  borderRadius: '12px',
                  backgroundColor: '#f8fff9',
                  width: '100%'
                }}>
                  <h3 style={{ 
                    margin: '0 0 20px 0', 
                    color: '#28a745',
                    fontSize: '20px',
                    fontWeight: 'bold',
                    textAlign: 'center'
                  }}>
                    吞咽周期分析结果
                  </h3>
                  
                  <div style={{ 
                    marginBottom: '20px',
                    padding: '15px',
                    backgroundColor: '#e8f5e8',
                    borderRadius: '8px',
                    textAlign: 'center'
                  }}>
                    <strong>该VFSS视频包含 {advancedData.swallowingAnalysis.totalSwallows} 段吞咽</strong>
                  </div>
                  
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ 
                      width: '100%', 
                      borderCollapse: 'collapse',
                      fontSize: '14px'
                    }}>
                      <thead>
                        <tr style={{ backgroundColor: '#28a745', color: 'white' }}>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>吞咽次数</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>起始帧 (BPM)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>峰值帧</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>结束帧 (SWALLOW REST)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>持续时间 (帧)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>起始时间 (秒)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>结束时间 (秒)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>持续时间 (秒)</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>峰值Z-Score</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>咽腔收缩率PCR</th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>误吸误咽风险<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(Normalized数据)</span></th>
                          <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>HYB<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(Hyoid Burst Onset)</span></th>
                <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>UESmax<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(UES Peak)</span></th>
                <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>UESO<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(UES Opening)</span></th>
                <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>UESC<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(UES Closing)</span></th>
                <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>LVC<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(Laryngeal Vestibule Closure)</span></th>
                <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>LVCoff<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(Laryngeal Vestibule Reopening)</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {advancedData.swallowingAnalysis.cycles.map((cycle: any, index: number) => (
                          <tr key={index} style={{ backgroundColor: index % 2 === 0 ? '#f9f9f9' : 'white' }}>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold' }}>
                              第{cycle.cycleNumber}次吞咽
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.startFrame}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.peakFrame}
                            </td>
                            <td style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.endFrame}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.duration}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.startTime.toFixed(2)}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.endTime.toFixed(2)}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.durationTime.toFixed(2)}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.peakValue.toFixed(3)}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.PCR ? (
                                <div>
                                  <div style={{ fontWeight: 'bold' }}>{cycle.PCR.toFixed(3)}</div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    5%: {cycle.PCR_p5?.toFixed(3)} / 95%: {cycle.PCR_p95?.toFixed(3)}
                                  </div>
                                  {cycle.PCR_hasNegativeValues && (
                                    <div style={{ fontSize: '10px', color: '#ff6b6b', fontStyle: 'italic' }}>
                                      已处理负值
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.aspirationRisk !== null ? (
                                <div>
                                  <div style={{ 
                                    fontWeight: 'bold', 
                                    color: cycle.aspirationRisk ? '#dc3545' : '#28a745',
                                    fontSize: '14px'
                                  }}>
                                    {cycle.aspirationRisk ? '⚠️ 存在风险' : '✅ 无风险'}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    最大比值: {cycle.maxOverlapRatio?.toFixed(3)}
                                  </div>
                                  <div style={{ fontSize: '10px', color: '#999' }}>
                                    阈值: {cycle.aspirationThreshold} (基于Normalized数据)
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.HYB !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#007bff' }}>
                                    {cycle.HYB}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    峰值: {cycle.HYB_peakFrame} | 谷底: {cycle.HYB_valleyFrame}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.UES_peakFrame !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#6f42c1' }}>
                                    {cycle.UES_peakFrame}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    峰值Z-Score: {cycle.UES_peakValue?.toFixed(3)}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.UESO !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#28a745' }}>
                                    {cycle.UESO}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    峰值: {cycle.UES_peakFrame} | 前谷底: {cycle.UES_beforeValleyFrame}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.UESC !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#ff6b6b' }}>
                                    {cycle.UESC}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    峰值: {cycle.UES_peakFrame} | 后谷底: {cycle.UES_afterValleyFrame}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.LVC !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#fd7e14' }}>
                                    {cycle.LVC}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    峰值: {cycle.LVC_peakFrame} | 谷底1: {cycle.LVC_valley1Frame}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                              {cycle.LVCoff !== null ? (
                                <div>
                                  <div style={{ fontWeight: 'bold', color: '#20c997' }}>
                                    {cycle.LVCoff}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#666' }}>
                                    谷底2: {cycle.LVC_valley2Frame} | 谷底1: {cycle.LVC_valley1Frame}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  
                  <div style={{ 
                    marginTop: '20px',
                    fontSize: '14px',
                    color: '#666',
                    fontStyle: 'italic',
                    textAlign: 'center'
                  }}>
                    <strong>参数说明：</strong> BPM = Bolus Passing Mandible（吞咽起始），SWALLOW REST = 吞咽结束后的稳定期中间值
                  </div>
                  
                  {/* 时间学参数表格 */}
                  <div style={{ 
                    marginTop: 24, 
                    padding: '20px', 
                    border: '2px solid #17a2b8', 
                    borderRadius: '12px',
                    backgroundColor: '#f8fcfd',
                    width: '100%'
                  }}>
                    <h3 style={{ 
                      margin: '0 0 20px 0', 
                      color: '#17a2b8',
                      fontSize: '20px',
                      fontWeight: 'bold',
                      textAlign: 'center'
                    }}>
                       时间学参数分析
                    </h3>
                    
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ 
                        width: '100%', 
                        borderCollapse: 'collapse',
                        fontSize: '14px'
                      }}>
                        <thead>
                          <tr style={{ backgroundColor: '#17a2b8', color: 'white' }}>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>吞咽次数</th>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>吞咽反应时间<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(HYB-BPM)</span></th>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>咽部反应时间<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(UESO-HYB)</span></th>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>UES打开持续时间<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(UESC-UESO)</span></th>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>LVC反应时间<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(LVC-HYB)</span></th>
                            <th style={{ padding: '12px', border: '1px solid #ddd', textAlign: 'center' }}>LVC持续时间<br/><span style={{ fontSize: '10px', fontWeight: 'normal' }}>(LVCoff-LVC)</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {advancedData.swallowingAnalysis.cycles.map((cycle: any, index: number) => {
                            // 计算时间学参数
                            const fps = 30; // 默认帧率，实际应该从视频信息获取
                            
                            // 参数1：吞咽反应时间 (HYB-BPM)
                            const swallowReactionTimeFrames = cycle.HYB !== null && cycle.startFrame !== null ? 
                              cycle.HYB - cycle.startFrame : null;
                            const swallowReactionTimeSeconds = swallowReactionTimeFrames !== null ? 
                              swallowReactionTimeFrames / fps : null;
                            
                            // 参数2：咽部反应时间 (UESO-HYB)
                            const pharyngealResponseTimeFrames = cycle.UESO !== null && cycle.HYB !== null ? 
                              cycle.UESO - cycle.HYB : null;
                            const pharyngealResponseTimeSeconds = pharyngealResponseTimeFrames !== null ? 
                              pharyngealResponseTimeFrames / fps : null;
                            
                            // 参数3：UES打开持续时间 (UESC-UESO)
                            const uesOpenDurationFrames = cycle.UESC !== null && cycle.UESO !== null ? 
                              cycle.UESC - cycle.UESO : null;
                            const uesOpenDurationSeconds = uesOpenDurationFrames !== null ? 
                              uesOpenDurationFrames / fps : null;
                            
                            // 参数4：LVC反应时间 (LVC-HYB)
                            const lvcReactionTimeFrames = cycle.LVC !== null && cycle.HYB !== null ? 
                              cycle.LVC - cycle.HYB : null;
                            const lvcReactionTimeSeconds = lvcReactionTimeFrames !== null ? 
                              lvcReactionTimeFrames / fps : null;
                            
                            // 参数5：LVC持续时间 (LVCoff-LVC)
                            const lvcDurationFrames = cycle.LVCoff !== null && cycle.LVC !== null ? 
                              cycle.LVCoff - cycle.LVC : null;
                            const lvcDurationSeconds = lvcDurationFrames !== null ? 
                              lvcDurationFrames / fps : null;
                            
                            return (
                              <tr key={index} style={{ backgroundColor: index % 2 === 0 ? '#f9f9f9' : 'white' }}>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold' }}>
                                  第{cycle.cycleNumber}次吞咽
                                </td>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                                  {swallowReactionTimeFrames !== null ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: swallowReactionTimeFrames >= 0 ? '#28a745' : '#dc3545' }}>
                                        {swallowReactionTimeFrames} 帧
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#666' }}>
                                        {swallowReactionTimeSeconds?.toFixed(3)} 秒
                                      </div>
                                    </div>
                                  ) : (
                                    <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                                  )}
                                </td>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                                  {pharyngealResponseTimeFrames !== null ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: pharyngealResponseTimeFrames >= 0 ? '#28a745' : '#dc3545' }}>
                                        {pharyngealResponseTimeFrames} 帧
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#666' }}>
                                        {pharyngealResponseTimeSeconds?.toFixed(3)} 秒
                                      </div>
                                    </div>
                                  ) : (
                                    <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                                  )}
                                </td>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                                  {uesOpenDurationFrames !== null ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: '#007bff' }}>
                                        {uesOpenDurationFrames} 帧
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#666' }}>
                                        {uesOpenDurationSeconds?.toFixed(3)} 秒
                                      </div>
                                    </div>
                                  ) : (
                                    <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                                  )}
                                </td>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                                  {lvcReactionTimeFrames !== null ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: lvcReactionTimeFrames >= 0 ? '#28a745' : '#dc3545' }}>
                                        {lvcReactionTimeFrames} 帧
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#666' }}>
                                        {lvcReactionTimeSeconds?.toFixed(3)} 秒
                                      </div>
                                    </div>
                                  ) : (
                                    <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                                  )}
                                </td>
                                <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                                  {lvcDurationFrames !== null ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: '#fd7e14' }}>
                                        {lvcDurationFrames} 帧
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#666' }}>
                                        {lvcDurationSeconds?.toFixed(3)} 秒
                                      </div>
                                    </div>
                                  ) : (
                                    <span style={{ color: '#999', fontStyle: 'italic' }}>N/A</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    
                    <div style={{ 
                      marginTop: '20px',
                      fontSize: '14px',
                      color: '#666',
                      fontStyle: 'italic',
                      textAlign: 'center'
                    }}>
                      <strong>时间学参数说明：</strong> 正值表示时间顺序正确，负值表示时间顺序异常
                    </div>
                  </div>
                </div>
              )}
              
            </>
          )}
        </>
      )}
    </div>
  );
}

export default App;