import Foundation
import ImageIO
import Vision

struct Observation: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("missing image path\n".utf8))
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard
    let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write(Data("invalid image\n".utf8))
    exit(3)
}

let customWords = ["年柱", "月柱", "日柱", "时柱", "天干", "地支", "甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]

func textRequest(region: CGRect? = nil) -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.customWords = customWords
    request.minimumTextHeight = 0.008
    if let region = region { request.regionOfInterest = region }
    return request
}

func recognizeCharacter(region: CGRect, allowed: String) throws -> String? {
    let request = textRequest(region: region)
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    for item in request.results ?? [] {
        for candidate in item.topCandidates(3) {
            for character in candidate.string {
                if allowed.contains(character) { return String(character) }
                if allowed.contains("丁") && ["J", "T", "丁"].contains(String(character)) { return "丁" }
            }
        }
    }
    return nil
}

let request = textRequest()

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    var observations = (request.results ?? []).compactMap { item -> Observation? in
        guard let candidate = item.topCandidates(1).first else { return nil }
        let box = item.boundingBox
        return Observation(
            text: candidate.string,
            x: Double(box.origin.x),
            y: Double(box.origin.y),
            width: Double(box.size.width),
            height: Double(box.size.height)
        )
    }
    let headers = (request.results ?? []).filter { item in
        guard let text = item.topCandidates(1).first?.string else { return false }
        return ["年柱", "月柱", "日柱", "时柱"].contains(text)
    }.sorted { $0.boundingBox.midX < $1.boundingBox.midX }
    if headers.count == 4, let headerY = headers.map({ $0.boundingBox.minY }).min() {
        for header in headers {
            let centerX = header.boundingBox.midX
            let x = max(0, centerX - 0.065)
            let width = min(0.13, 1 - x)
            let stemRegion = CGRect(x: x, y: max(0, headerY - 0.105), width: width, height: 0.085)
            let branchRegion = CGRect(x: x, y: max(0, headerY - 0.17), width: width, height: 0.075)
            if let stem = try recognizeCharacter(region: stemRegion, allowed: "甲乙丙丁戊己庚辛壬癸") {
                observations.append(Observation(text: stem, x: Double(centerX), y: Double(headerY - 0.07), width: 0.01, height: 0.01))
            }
            if let branch = try recognizeCharacter(region: branchRegion, allowed: "子丑寅卯辰巳午未申酉戌亥") {
                observations.append(Observation(text: branch, x: Double(centerX), y: Double(headerY - 0.135), width: 0.01, height: 0.01))
            }
        }
    }
    let data = try JSONEncoder().encode(["observations": observations])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("recognition failed\n".utf8))
    exit(4)
}
