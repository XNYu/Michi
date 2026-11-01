import SwiftUI
import UIKit

struct NativeCameraCapture: UIViewControllerRepresentable {
    let onPhoto: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onPhoto: onPhoto) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = ["public.image"]
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onPhoto: (Data?) -> Void
        init(onPhoto: @escaping (Data?) -> Void) { self.onPhoto = onPhoto }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onPhoto(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onPhoto((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }
    }
}
